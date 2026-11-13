import{withdrawalCardHash}from'../shared/withdrawn-delivery.js';
import {stateView} from '../shared/state-view.js';
const turnActive=t=>['queued','thinking','decided','ready'].includes(t.status);
const jobActive=j=>['queued','running','cancelling','awaiting_instruction','awaiting_clarification','awaiting_approval','awaiting_environment_approval'].includes(j.status);
const identity=x=>JSON.stringify([x.profile,x.chatId,x.messageId]);
// A missing message, authentication failure or API timeout is NOT proof of recall.
export function withdrawalCandidates(s){
 const pending=new Set();
 for(const name of ['reportDeliveries','websiteEvidenceDeliveries','stickerDeliveries','longInvestigationNotices'])for(const e of Object.values(s[name]??{}))if(!e.messageId&&!e.superseded)pending.add(e.questionId);
 for(const [key,c]of Object.entries(s.cardMessages??{}))if(key.startsWith('question:')&&c.error!=='原消息已撤回，停止更新'&&(c.revision!==c.deliveredRevision||c.terminalMention&&!c.mentionDelivered))pending.add(key.slice(9));
 for(const j of s.jobs??[])if(jobActive(j))pending.add(j.questionId);
 for(const t of s.conversations??[])if(turnActive(t))pending.add(t.questionId);
 const candidates=new Map(),add=x=>{if(x.profile&&x.chatId&&x.messageId)candidates.set(identity(x),x);};
 for(const q of Object.values(s.questions??{}))if(!q.withdrawnAt&&pending.has(q.id)){
  add({profile:q.profile,chatId:q.chatId,messageId:q.messageId});
  if(q.threadRootId&&q.threadRootId!==q.messageId)add({profile:q.profile,chatId:q.chatId,messageId:q.threadRootId});
 }
 // Includes intake before a question is activated. Supplement recall only
 // cancels its own intake; it never cancels an unrelated root investigation.
 for(const t of s.conversations??[])if(turnActive(t)&&!t.withdrawnAt)add({profile:t.profile,chatId:t.sourceChatId??t.chatId,messageId:t.messageId});
 return [...candidates.values()];
}
export function applyWithdrawal(s,target,at=new Date().toISOString()){
 const qs=Object.values(s.questions??{}).filter(q=>q.profile===target.profile&&q.chatId===target.chatId&&[q.messageId,q.threadRootId].includes(target.messageId)&&!q.withdrawnAt),ids=new Set(qs.map(q=>q.id));
 const turns=(s.conversations??[]).filter(t=>t.profile===target.profile&&(ids.has(t.questionId)&&t.chatId===target.chatId||(t.sourceChatId??t.chatId)===target.chatId&&t.messageId===target.messageId));
 const turnIds=[];
 for(const q of qs)Object.assign(q,{withdrawnAt:at,withdrawnMessageId:target.messageId,closedAt:q.closedAt??at});
 for(const t of turns)if(turnActive(t)){Object.assign(t,{withdrawnAt:at,status:'cancelled',completedAt:at,cancelReason:'source_message_withdrawn'});turnIds.push(t.id);}
 const jobs=[];
 for(const j of s.jobs??[])if(ids.has(j.questionId)&&jobActive(j)&&j.status!=='cancelling'){
  j.status=j.status==='running'?'cancelling':'cancelled';j.updatedAt=at;j.cancelReason='原提问或话题已撤回';j.events.push({type:j.status==='cancelling'?'cancel_requested':'cancelled',by:'source_message_withdrawn',at,messageId:target.messageId});jobs.push(j.id);
 }
 for(const q of qs){const c=s.cardMessages?.['question:'+q.id];if(c)Object.assign(c,{error:'原消息已撤回，停止更新',withdrawnAt:at,retryAt:0,sourceWithdrawal:{questionId:q.id,messageId:target.messageId,profile:q.profile,chatId:q.chatId,at,cardHash:withdrawalCardHash(c)}});}
 for(const name of ['reportDeliveries','websiteEvidenceDeliveries','stickerDeliveries','longInvestigationNotices'])for(const e of Object.values(s[name]??{}))if(ids.has(e.questionId)&&!e.messageId)Object.assign(e,{superseded:true,reason:'source_message_withdrawn'});
 for(const name of ['receptionInbox','recoveryEvents','environmentEnrollments'])for(const e of Object.values(s[name]??{}))if(ids.has(e.questionId)&&!['sent','complete','completed','cancelled','superseded'].includes(e.status))Object.assign(e,{status:'cancelled',cancelReason:'source_message_withdrawn'});
 return {questionIds:[...ids],turnIds,jobIds:jobs};
}
export class WithdrawalWatcher{
 constructor(context,{intervalMs=10000}={}){this.context=context;this.intervalMs=intervalMs;this.closed=false;}
 start(){if(typeof this.context.feishu.getMessage!=='function'||this.timer)return;this.tick().catch(()=>{});this.timer=setInterval(()=>this.tick().catch(()=>{}),this.intervalMs);this.timer.unref();}
 async close(){this.closed=true;clearInterval(this.timer);await this.running;}
 async tick(){if(this.closed)return;if(this.running)return this.running;const work=this.run();this.running=work;try{return await work;}finally{this.running=null;}}
 async run(){
  const targets=await stateView(this.context.store,withdrawalCandidates);
  // Bounded parallel transport, no model invocation or task deadline. Shared
  // bot/root lookups are deduplicated, and only active/pending work is scanned.
  const pending=[...targets];await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{while(pending.length&&!this.closed){const target=pending.shift();try{
   const m=await this.context.feishu.getMessage(target.messageId,{profile:target.profile});
   if(this.closed||m?.message_id!==target.messageId||m.chat_id!==target.chatId||m.deleted!==true)continue;
   const changed=await this.context.store.transact(s=>applyWithdrawal(s,target));
   this.context.conversations?.abortWithdrawn?.(changed.turnIds);
  }catch{/* Fail open for execution: errors are never interpreted as user recall. */}}}));
 }
}
