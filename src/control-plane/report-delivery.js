import {createHash} from 'node:crypto';
import {reportFile} from '../shared/report-files.js';
import {messageIdOf} from './live-cards.js';
// Reports are per-question business artifacts, never shared knowledge or a public download URL.
export class ReportDelivery {
 constructor(context){this.context=context;this.workers=new Map();this.closed=false;}
 async enqueue(job){
  if(!job||job.nextJobId||job.status!=='completed'||job.result?.outcome!=='ready')return;
  const snapshot=await this.context.store.read();
  if(!snapshot.jobs.some(j=>(job.questionId?j.questionId===job.questionId:j.id===job.id)&&j.reportFiles?.length))return;
  await this.context.store.transact(state=>{
   const current=state.jobs.find(j=>j.id===job.id);if(current?.status!=='completed'||current.result?.outcome!=='ready')return;
   const q=state.questions?.[job.questionId];
   if(q&&state.jobs.filter(j=>j.questionId===job.questionId).at(-1)?.id!==job.id)return;
   const jobs=job.questionId?state.jobs.filter(j=>j.questionId===job.questionId):[current];
   state.reportDeliveries??={};
   for(const source of jobs)for(const item of source.reportFiles??[]){
    if(q&&item.questionGeneration!==q.generation)continue;
    const key=source.id+':'+item.id;if(state.reportDeliveries[key])continue;
    const messageId=q?.messageId??job.originMessageId??job.replyToMessageId;if(!messageId)continue;
    state.reportDeliveries[key]={sourceJobId:source.id,questionId:job.questionId,questionGeneration:q?.generation,item,destination:{messageId,profile:q?.profile??job.originProfile??job.agentProfile,replyInThread:q?.replyInThread??job.originReplyInThread??false},createdAt:new Date().toISOString()};
   }
  });
  await this.retry();
 }
 async recover(){
  const state=await this.context.store.read();const questions=new Set(state.jobs.filter(j=>j.reportFiles?.length).map(j=>j.questionId));
  for(const id of questions){const latest=state.jobs.filter(j=>j.questionId===id).at(-1);if(latest)await this.enqueue(latest);}
 }
 async retry(snapshot){
  if(this.closed||typeof this.context.feishu.replyFile!=='function')return;
  const state=snapshot??await this.context.store.read();
  for(const [key,entry] of Object.entries(state.reportDeliveries??{}))if(!entry.messageId&&!entry.superseded&&Date.now()>=(entry.retryAt??0)&&!this.workers.has(key)){
   if(entry.questionId&&state.questions?.[entry.questionId]?.generation!==entry.questionGeneration){await this.context.store.transact(s=>{s.reportDeliveries[key].superseded=true;});continue;}
   const work=this.deliver(key,entry);this.workers.set(key,work);work.finally(()=>this.workers.delete(key)).catch(()=>{});
  }
  await Promise.allSettled([...this.workers.values()]);
 }
 async deliver(key,entry){
  try{
   const {file}=await reportFile(this.context.config.dataDir,entry.sourceJobId,entry.item);
   const result=await this.context.feishu.replyFile(entry.destination.messageId,file,{...entry.destination,idempotencyKey:'aos-report-'+createHash('sha256').update(key).digest('hex').slice(0,32)});
   const id=messageIdOf(result);if(!id)throw new Error('没有文件消息编号');
   await this.context.store.transact(state=>Object.assign(state.reportDeliveries[key],{messageId:id,deliveredAt:new Date().toISOString(),failures:0,retryAt:0}));
  }catch{
   await this.context.store.transact(state=>{const e=state.reportDeliveries[key];e.failures=(e.failures??0)+1;e.retryAt=Date.now()+Math.min(300000,5000*2**Math.min(e.failures,6));e.error='文件发送或校验未通过；保留文件并等待重试，不重新查询数据库';});
  }
 }
 async close(){this.closed=true;await Promise.allSettled([...this.workers.values()]);}
}
