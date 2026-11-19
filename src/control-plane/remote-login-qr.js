import {createHash} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {stateView} from '../shared/state-view.js';
import {websiteSessionKey} from '../shared/website-policy.js';
import {isEnvironmentOwner,loadEnvironments} from '../shared/environment-access.js';
import {messageIdOf} from './live-cards.js';

// Operator-only authentication outbox. No QR bytes, URL, cookie or token in state/model/group cards.
export class RemoteLoginQr {
 constructor(context,{now=()=>Date.now(),load=loadEnvironments}={}){this.context=context;this.now=now;this.load=load;this.workers=new Map();this.closed=false;}
 binding(job,e){
  const profile=job.originProfile,owner=this.context.projects.humanIdentities?.groupOwner?.[profile];
  if(e.loginNavigation?.remoteQr!==true||!profile||!owner||!(this.context.projects.ownerOpenIdsByProfile?.[profile]??[]).includes(owner)||!isEnvironmentOwner(e,{profile,senderId:owner}))return null;
  const session=websiteSessionKey(e.projectId,e.tier,e.baseUrl);
  return {profile,owner,session,key:createHash('sha256').update(JSON.stringify([profile,owner,session,e.baseUrl,e.credentialRef])).digest('hex')};
 }
 async observe(job,e,status){
  const b=this.binding(job,e);if(!b||this.closed)return;
  if(this.workers.has(b.key))return this.workers.get(b.key);
  const work=this.update(job,e,status,b).finally(()=>this.workers.delete(b.key));this.workers.set(b.key,work);return work;
 }
 async valid(job,e,b){
  const current=await this.context.store.getJob(job.id);
  return current?.status==='awaiting_clarification'&&current.result?.browserLoginRequired===true&&current.environmentAccess?.scopeHash===job.environmentAccess?.scopeHash&&current.originProfile===b.profile&&current.projectId===e.projectId;
 }
 async retire(entry){
  if(entry?.messageId&&!entry.retiredAt)await this.context.feishu.cardRequest('DELETE','/open-apis/im/v1/messages/'+encodeURIComponent(entry.messageId),{},{profile:entry.profile});
 }
 async update(job,e,status,b){
  if(!await this.valid(job,e,b))return;
  let entry=await stateView(this.context.store,s=>s.remoteLoginQr?.[b.key]);
  const terminal=status.pageReady===true&&!status.loginRequired?'authenticated':status.verificationExpired?'expired':null;
  if(terminal){
   if(entry&&entry.state!==terminal&&(terminal==='authenticated'||entry.jobId===job.id)){await this.context.store.transact(s=>{const v=s.remoteLoginQr?.[b.key];if(v?.generation===entry.generation){v.state=terminal;v.retirePending=true;}});await this.sweep();}return;
  }
  if(!status.verificationRequired||!status.loginRequired)return;
  // Never resend an expired challenge. A private admin command can request a fresh challenge.
  if(entry?.state==='expired'&&entry.jobId===job.id&&!entry.refreshRequested)return;
  if(entry?.state==='sent'&&this.now()-Date.parse(entry.createdAt)<180000)return;
  if(!entry?.retiredAt&&entry?.retryAt>this.now())return;
  let image;
  try{
   image=await this.context.websiteBrowser.captureLoginQr(job,e);if(!image||!await this.valid(job,e,b))return;
   if(entry?.sha256===image.sha256&&entry.state==='sent')return;
   if(!entry||entry.sha256!==image.sha256||['authenticated','closed','expired'].includes(entry.state)){
    await this.retire(entry);
    entry={...b,jobId:job.id,environmentId:job.environmentAccess.environmentId,sha256:image.sha256,generation:(entry?.generation??0)+1,state:'pending',createdAt:new Date(this.now()).toISOString()};
    await this.context.store.transact(s=>{s.remoteLoginQr??={};s.remoteLoginQr[b.key]=entry;});
   }
   const uuid=createHash('sha256').update('login-qr:'+b.key+':'+entry.generation).digest('hex').slice(0,32);
   if(!entry.noticeMessageId){
    const receipt=await this.context.feishu.cardRequest('POST','/open-apis/im/v1/messages',{receive_id:b.owner,msg_type:'text',content:JSON.stringify({text:`【任务网页登录】${e.projectId} / ${e.tier} 需要扫码验证。请用对应应用扫描下一张二维码；登录成功后原任务自动继续。二维码过期可在本私聊回复“刷新扫码”。无需发送密码。`}),uuid:uuid+'-note'},{profile:b.profile,params:{receive_id_type:'open_id'}});
    const id=messageIdOf(receipt);if(!id)throw Error('Private QR notice receipt missing');
    await this.context.store.transact(s=>{s.remoteLoginQr[b.key].noticeMessageId=id;});entry.noticeMessageId=id;
   }
   const dir=path.join(this.context.config.dataDir,'private-login-qr');await mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,b.key+'-'+entry.generation+'.png');
   try{
    await writeFile(file,image.buffer,{mode:0o600});
    if(!await this.valid(job,e,b))return;
    const sent=await this.context.feishu.replyImage(null,file,{profile:b.profile,privateRecipient:b.owner,idempotencyKey:uuid});
    const id=messageIdOf(sent);if(!id)throw Error('Private QR image receipt missing');
    await this.context.store.transact(s=>{const v=s.remoteLoginQr[b.key];v.messageId=id;v.state='sent';v.sentAt=new Date(this.now()).toISOString();delete v.refreshRequested;delete v.retryAt;});
   }finally{await rm(file,{force:true});if(this.context.feishu.cwd)await rm(path.join(this.context.feishu.cwd,'images',path.basename(file)),{force:true});}
  }catch{
   await this.context.store.transact(s=>{const v=s.remoteLoginQr?.[b.key];if(v){v.retryAt=this.now()+30000;v.error='PRIVATE_QR_DELIVERY_UNAVAILABLE';}});
  }
 }
 async sweep(){
  const entries=await stateView(this.context.store,s=>Object.entries(s.remoteLoginQr??{}).filter(([,e])=>e.retirePending||e.state==='sent'&&!(s.jobs??[]).some(j=>j.id===e.jobId&&j.status==='awaiting_clarification'&&j.result?.browserLoginRequired)));
  for(const[key,entry]of entries){try{await this.retire(entry);await this.context.store.transact(s=>{const v=s.remoteLoginQr?.[key];if(v?.generation===entry.generation){v.state=v.state==='sent'?'closed':v.state;v.retirePending=false;v.retiredAt=new Date(this.now()).toISOString();}});}catch{/* Keep the exact private receipt for the next cleanup attempt. */}}
 }
 async close(){this.closed=true;await Promise.allSettled([...this.workers.values()]);}
 async handle(event){
  if(event.chat_type==='group'||String(event.content??'').trim()!=='刷新扫码')return null;
  const profile=event.agent_profile,owner=this.context.projects.humanIdentities?.groupOwner?.[profile];
  if(!owner||event.sender_id!==owner)return null;
  const cfg=await this.load(),jobs=await stateView(this.context.store,s=>(s.jobs??[]).filter(j=>j.originProfile===profile&&j.status==='awaiting_clarification'&&j.result?.browserLoginRequired));
  const handled=new Set();
  for(const job of jobs){const e=cfg.environments[job.environmentAccess?.environmentId],b=e&&this.binding(job,e);if(!b||handled.has(b.key))continue;handled.add(b.key);
   const previous=this.workers.get(b.key)??Promise.resolve();
   const work=previous.then(async()=>{
    if(!await this.valid(job,e,b))return;
    await this.context.websiteBrowser.refreshLoginQr(job,e);
    await this.context.store.transact(s=>{if(s.remoteLoginQr?.[b.key])s.remoteLoginQr[b.key].refreshRequested=true;});
    await this.update(job,e,await this.context.websiteBrowser.loginStatusFor(job,e),b);
   }).finally(()=>{if(this.workers.get(b.key)===work)this.workers.delete(b.key);});
   this.workers.set(b.key,work);await work;
  }
  return {remoteLoginQr:true};
 }
}
