import path from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {realDirectory} from '../shared/retention.js';
import {privateRecipient} from './private-cards.js';
import {messageIdOf} from './live-cards.js';
import {screenshotRequested} from '../shared/browser-tool-input.js';
export {screenshotRequested};
// Control-plane generated manifests only; never accept Runner-supplied filesystem paths.
export async function websiteEvidenceFile(dataDir,jobId,item){
 if(!/^[A-Za-z0-9_-]+$/.test(jobId)||!/^[-a-f0-9]+\.png$/.test(item?.name??'')||!Number.isInteger(item.bytes)||item.bytes<8||item.bytes>10*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw new Error('Invalid website evidence');
 const dir=path.join(dataDir,'website-evidence',jobId);if(!await realDirectory(dir))throw new Error('Invalid evidence directory');
 const file=path.join(dir,item.name),st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size!==item.bytes)throw new Error('Invalid evidence file');
 const buffer=await readFile(file);if(buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(buffer).digest('hex')!==item.sha256)throw new Error('Evidence integrity failed');return file;
}
export class WebsiteEvidenceDelivery {
 constructor(context){this.context=context;this.workers=new Map();this.closed=false;}
 async capture(job,item){
  if(!screenshotRequested(job))throw new Error('当前原问题未要求截图交付');
  await websiteEvidenceFile(this.context.config.dataDir,job.id,item);
  const key=job.id+':'+item.sha256;
  await this.context.store.transact(state=>{
   const current=state.jobs.find(j=>j.id===job.id),q=state.questions?.[job.questionId];
   if(current?.status!=='running'||current.lease?.id!==job.lease?.id)throw new Error('Screenshot lease changed');
   const messageId=q?.messageId??current.originMessageId??current.replyToMessageId;if(!messageId)throw new Error('Screenshot destination missing');
   state.websiteEvidenceDeliveries??={};
   state.websiteEvidenceDeliveries[key]??={sourceJobId:job.id,questionId:job.questionId,questionGeneration:q?.generation,item,destination:{messageId,profile:q?.profile??current.originProfile??current.agentProfile,replyInThread:q?.replyInThread??current.originReplyInThread??false,privateRecipient:privateRecipient(state,current)},createdAt:new Date().toISOString()};
  });
  // Failed delivery stays in an outbox; it must never repeat a webpage action.
  void this.retry().catch(()=>{});const entry=(await this.context.store.read()).websiteEvidenceDeliveries?.[key];return {delivery:entry?.messageId?'sent':'pending',messageId:entry?.messageId??null};
 }
 async status(job){
  const state=await this.context.store.read(),q=state.questions?.[job.questionId];
  return Object.values(state.websiteEvidenceDeliveries??{}).filter(e=>e.sourceJobId===job.id&&(!job.questionId||e.messageId||e.questionGeneration===q?.generation)&&!e.superseded).map(e=>({...e.item,delivery:e.messageId?'sent':'pending',messageId:e.messageId??null}));
 }
 async retry(){
  if(this.closed||typeof this.context.feishu.replyImage!=='function')return;
  const state=await this.context.store.read();
  for(const [key,entry]of Object.entries(state.websiteEvidenceDeliveries??{}))if(!entry.messageId&&!entry.superseded&&Date.now()>=(entry.retryAt??0)&&!this.workers.has(key)){
   const work=this.deliver(key,entry);this.workers.set(key,work);work.finally(()=>this.workers.delete(key)).catch(()=>{});
  }
  await Promise.allSettled([...this.workers.values()]);
 }
 async deliver(key,entry){
  try{
   const state=await this.context.store.read(),job=state.jobs.find(j=>j.id===entry.sourceJobId),q=state.questions?.[entry.questionId];
   if(!job||!screenshotRequested(job)||job.status==='cancelled'||entry.questionId&&(!q||q.generation!==entry.questionGeneration)){await this.context.store.transact(s=>{s.websiteEvidenceDeliveries[key].superseded=true;});return;}
   const recipient=privateRecipient(state,job);if(recipient!==entry.destination.privateRecipient)throw new Error('Evidence recipient changed');
   const file=await websiteEvidenceFile(this.context.config.dataDir,entry.sourceJobId,entry.item);
   const result=await this.context.feishu.replyImage(entry.destination.messageId,file,{...entry.destination,idempotencyKey:'aos-web-'+createHash('sha256').update(key).digest('hex').slice(0,32)});
   const messageId=messageIdOf(result);if(!messageId)throw new Error('Image receipt missing');
   await this.context.store.transact(s=>Object.assign(s.websiteEvidenceDeliveries[key],{messageId,deliveredAt:new Date().toISOString(),failures:0,retryAt:0}));
  }catch{await this.context.store.transact(s=>{const e=s.websiteEvidenceDeliveries[key];if(!e)return;e.failures=(e.failures??0)+1;e.retryAt=Date.now()+Math.min(300000,5000*2**Math.min(e.failures,6));e.error='截图发送或校验未完成，将重试投递，不重复网页操作';});}
 }
 async close(){this.closed=true;await Promise.allSettled([...this.workers.values()]);}
}
