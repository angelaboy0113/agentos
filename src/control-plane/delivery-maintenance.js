import{applyWithdrawal}from'./withdrawals.js';
import{createHash}from'node:crypto';
import{stateView}from'../shared/state-view.js';
import{DELIVERY_GROUPS,deliveryAttention,deliveryFingerprint,deliveryHeld,deliveryPending}from'../shared/delivery-retry.js';
import{messageIdOf}from'./live-cards.js';
export class DeliveryMaintenance{
 constructor(context,{now=()=>Date.now()}={}){this.context=context;this.now=now;this.closed=false;}
 start(){if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),30000);this.timer.unref();}
 async close(){this.closed=true;clearInterval(this.timer);await this.running;}
 async tick(){if(this.closed||this.running)return;this.running=this.run().catch(()=>{});try{await this.running;}finally{this.running=null;}}
 async run(){
  const{store,projects}=this.context,now=this.now();
  // Only legacy, terminal, already-failing outboxes need adoption. New failure
  // histories are maintained at the actual transport boundary, per payload.
  const legacy=await stateView(store,s=>DELIVERY_GROUPS.flatMap(group=>Object.entries(s[group]??{}).filter(([key,e])=>{
   const q=s.questions?.[e.questionId??(key.startsWith('question:')?key.slice(9):'')];
   return !e.deliveryRetry&&e.failures>=12&&deliveryPending(group,e)&&!q?.withdrawnAt&&!(s.jobs??[]).some(j=>j.questionId===q?.id&&['queued','running','cancelling'].includes(j.status))&&now-Date.parse(e.createdAt??q?.createdAt)>=1800000;
  }).map(([key,e])=>({group,key,fingerprint:deliveryFingerprint(group,e)}))));
  if(legacy.length)await store.transact(s=>{for(const x of legacy){const e=s[x.group]?.[x.key];if(!e||e.deliveryRetry||deliveryFingerprint(x.group,e)!==x.fingerprint)continue;e.deliveryRetry={policy:'delivery-retry-v1',fingerprint:x.fingerprint,state:'attention',attempts:e.failures,heldAt:now,lastFailureAt:now,reason:'legacy_repeated_failures',errorClass:'historical_transport_or_validation'};e.error='投递待维护：历史重复失败，已停止自动重试，保留原结果与回执';}});
  const alerts=await stateView(store,s=>deliveryAttention(s).map(x=>{
   const e=s[x.group][x.key],q=s.questions?.[x.questionId];return {...x,chatId:q?.chatId??e.destination?.chatId??e.chatId};
  }));
  for(const x of alerts){
   if(this.closed)return;
   const owners=projects.ownerOpenIdsByProfile?.[x.profile]??[];
   for(const owner of owners){
    if(!/^ou_[A-Za-z0-9]+$/.test(owner)||!x.chatId||typeof this.context.feishu.sendPrivateCard!=='function')continue;
    const id=createHash('sha256').update(JSON.stringify([x.group,x.key,x.fingerprint,owner])).digest('hex');
    const claim=await store.transact(s=>{const e=s[x.group]?.[x.key];if(!e||!deliveryHeld(x.group,e)||deliveryFingerprint(x.group,e)!==x.fingerprint)return false;s.deliveryMaintenanceNotices??={};if(s.deliveryMaintenanceNotices[id])return false;s.deliveryMaintenanceNotices[id]={group:x.group,key:x.key,fingerprint:x.fingerprint,profile:x.profile,owner,attemptedAt:now,status:'unconfirmed'};return true;});
    if(!claim)continue;
    // One private attempt per payload/admin, no recursive retry storm of alerts.
    try{
     const root=await stateView(store,s=>s.questions?.[x.questionId]);
     if(root?.withdrawnAt)continue;
     if(root?.messageId&&root.profile===x.profile&&typeof this.context.feishu.getMessage==='function'){
      const m=await this.context.feishu.getMessage(root.messageId,{profile:x.profile});
      if(m?.deleted===true&&m.message_id===root.messageId&&m.chat_id===root.chatId){await store.transact(s=>applyWithdrawal(s,{messageId:root.messageId,profile:root.profile,chatId:root.chatId}));continue;}
     }
     const sent=await this.context.feishu.sendPrivateCard(x.chatId,owner,{schema:'2.0',header:{title:{tag:'plain_text',content:'一条结果投递需要维护'},template:'orange'},body:{elements:[{tag:'markdown',content:`已停止重复投递，原结果和回执保留。\n类型：${x.group}\n问题：${x.questionId??'私聊素材登记'}\n请在本机后台「投递待维护」检查后重投；不会重新执行业务查询。`}]}},{profile:x.profile,idempotencyKey:'aos-delivery-alert-'+id.slice(0,32)});const messageId=messageIdOf(sent);if(!messageId)throw Error('No receipt');await store.transact(s=>Object.assign(s.deliveryMaintenanceNotices[id],{messageId,status:'sent',deliveredAt:this.now()}));}
    catch{await store.transact(s=>{s.deliveryMaintenanceNotices[id].status='unconfirmed';});}
   }
  }
 }
}
