import {createHash} from 'node:crypto';
import {stateView} from '../shared/state-view.js';
import {validateFailureNotice,requesterMentionText} from './requester-mention.js';
import {messageIdOf} from './live-cards.js';
const values=x=>Object.values(x??{}),date=x=>Date.parse(x),active=j=>['queued','running'].includes(j.status)||j.status==='awaiting_clarification'&&j.result?.modelCapacityWaiting===true;
export function validateLongInvestigationNotice(value,identities={}){
 if(value===undefined)return undefined;validateFailureNotice(value,identities);
 if(!Number.isSafeInteger(value.minutes)||value.minutes<1||value.minutes>Number.MAX_SAFE_INTEGER/60000)throw Error('Invalid investigation notice minutes');return value;
}
// Union execution-wall intervals, not summed parallel tool/job durations. Human
// waits close at a completed event and reopen on authenticated clarification or approval.
export function investigationElapsed(jobs,startAt,now=Date.now()){
 const lower=date(startAt),intervals=[];if(!Number.isFinite(lower))return 0;
 for(const j of jobs){
  if(j.taskIntent!=='analysis')continue;
  const events=[...(j.events??[])].filter(e=>Number.isFinite(date(e.at))).sort((a,b)=>date(a.at)-date(b.at));
  const approval=events.find(e=>e.type==='environment_approved'),started=events.find(e=>e.type==='started');
  const requiresApproval=j.status==='awaiting_environment_approval'||j.environmentAccess?.approvalRequired===true||approval&&(!started||date(approval.at)<=date(started.at));
  let from=requiresApproval?null:date(j.createdAt);
  const close=until=>{if(Number.isFinite(from)&&Number.isFinite(until)&&until>from)intervals.push([Math.max(lower,from),Math.min(now,until)]);from=null;};
  for(const e of events){const at=date(e.at);if(at>now)continue;
   if(['clarification_received','environment_approved'].includes(e.type)){if(from===null)from=at;}
   else if(['completed','failed','cancelled'].includes(e.type)&&!e.result?.modelCapacityWaiting)close(at);
  }
  if(active(j))close(now);else close(date(j.updatedAt));
 }
 let total=0,end=lower;for(const [a,b]of intervals.filter(([a,b])=>b>a).sort((x,y)=>x[0]-y[0])){if(b>end){total+=b-Math.max(a,end);end=b;}}return total;
}
function current(state,q){
 if(!q||q.visibility==='requester')return null;
 const turn=(state.conversations??[]).find(t=>t.id===q.latestTurnId),root=(state.conversations??[]).find(t=>t.id===q.rootTurnId);
 if(root?.chatType!=='group'||!turn||turn.visibility==='requester'||root.profile!==q.profile||turn.profile!==q.profile||root.chatId!==q.chatId||turn.chatId!==q.chatId)return null;
 const jobs=(state.jobs??[]).filter(j=>j.questionId===q.id&&j.projectId===q.projectId&&(j.originProfile??j.agentProfile)===q.profile);
 const last=jobs.at(-1);if(!last||!active(last)||last.visibility==='requester'||last.taskIntent!=='analysis')return null;
 return {jobs,startAt:turn.createdAt,turnId:turn.id};
}
const keyFor=q=>createHash('sha256').update(JSON.stringify([q.profile,q.projectId,q.chatId,q.id,q.latestTurnId])).digest('hex');
export class LongInvestigationNotices{
 constructor(context,{now=()=>Date.now(),intervalMs=30000}={}){this.context=context;this.now=now;this.intervalMs=intervalMs;this.closed=false;}
 start(){if(this.timer)return;this.retry().catch(()=>{});this.timer=setInterval(()=>this.retry().catch(()=>{}),this.intervalMs);this.timer.unref();}
 async close(){this.closed=true;clearInterval(this.timer);await this.running;}
 async retry(){if(this.closed)return;if(this.running)return this.running;const work=this.run();this.running=work;try{return await work;}finally{this.running=null;}}
 async run(){
  const {store,projects}=this.context,policy=projects.longInvestigationNotice,now=this.now();
  if(!policy?.enabled){const pending=await stateView(store,s=>Object.entries(s.longInvestigationNotices??{}).filter(([,e])=>!e.messageId&&!e.superseded).map(([key])=>key));if(pending.length)await store.transact(s=>{for(const key of pending)Object.assign(s.longInvestigationNotices[key],{superseded:true,reason:'policy_disabled'});});return;}
  const snapshot=await stateView(store,s=>({questions:s.questions,jobs:(s.jobs??[]).map(j=>({id:j.id,questionId:j.questionId,projectId:j.projectId,originProfile:j.originProfile,agentProfile:j.agentProfile,status:j.status,taskIntent:j.taskIntent,visibility:j.visibility,result:{modelCapacityWaiting:j.result?.modelCapacityWaiting},createdAt:j.createdAt,updatedAt:j.updatedAt,environmentAccess:{approvalRequired:j.environmentAccess?.approvalRequired},events:(j.events??[]).filter(e=>['started','completed','failed','cancelled','clarification_received','environment_approved'].includes(e.type)).map(e=>({type:e.type,at:e.at,result:{modelCapacityWaiting:e.result?.modelCapacityWaiting}}))})),conversations:(s.conversations??[]).map(t=>({id:t.id,profile:t.profile,chatId:t.chatId,chatType:t.chatType,visibility:t.visibility,createdAt:t.createdAt})),longInvestigationNotices:s.longInvestigationNotices}));
  if(policy?.enabled&&now>=date(policy.since)){
   validateLongInvestigationNotice(policy,projects.humanIdentities);
   for(const q of values(snapshot.questions)){
    const scope=current(snapshot,q),key=keyFor(q);if(!scope||snapshot.longInvestigationNotices?.[key])continue;
    const elapsedMs=investigationElapsed(scope.jobs,scope.startAt,now);if(elapsedMs<policy.minutes*60000)continue;
    const id=projects.humanIdentities[policy.humanId]?.[q.profile],text=requesterMentionText(id,policy.message.replaceAll('{minutes}',String(policy.minutes)));if(!text)continue;
    await store.transact(s=>{const fresh=s.questions?.[q.id],still=current(s,fresh);if(!still||fresh.latestTurnId!==q.latestTurnId||investigationElapsed(still.jobs,still.startAt,now)<policy.minutes*60000)return;
     s.longInvestigationNotices??={};s.longInvestigationNotices[key]??={questionId:q.id,turnId:q.latestTurnId,profile:q.profile,projectId:q.projectId,chatId:q.chatId,replyTo:q.messageId,text,idempotencyKey:'aos-long-'+key.slice(0,32),thresholdMinutes:policy.minutes,elapsedMs,createdAt:new Date(now).toISOString(),failures:0,retryAt:0};});
   }
  }
  const pending=await stateView(store,s=>Object.entries(s.longInvestigationNotices??{}).filter(([,e])=>!e.messageId&&!e.superseded&&!e.reconciliationRequired));
  for(const [key,e]of pending){
   const valid=await stateView(store,s=>{const q=s.questions?.[e.questionId];return policy?.enabled&&now>=date(policy.since)&&q?.profile===e.profile&&q?.chatId===e.chatId&&q?.projectId===e.projectId&&q?.messageId===e.replyTo&&q?.latestTurnId===e.turnId&&Boolean(current(s,q));});
   if(!valid){await store.transact(s=>Object.assign(s.longInvestigationNotices[key],{superseded:true,reason:'question_or_policy_no_longer_active'}));continue;}
   if(now<(e.retryAt??0))continue;
   if(e.firstAttemptAt!==undefined&&now-e.firstAttemptAt>=55*60000){await store.transact(s=>s.longInvestigationNotices[key].reconciliationRequired=true);continue;}
   await store.transact(s=>s.longInvestigationNotices[key].firstAttemptAt??=now);
   try{const result=await this.context.feishu.reply(e.replyTo,e.text,{profile:e.profile,replyInThread:true,idempotencyKey:e.idempotencyKey});const messageId=messageIdOf(result);if(!messageId)throw Error('Missing notice receipt');await store.transact(s=>Object.assign(s.longInvestigationNotices[key],{messageId,deliveredAt:new Date(this.now()).toISOString(),failures:0,retryAt:0}));}
   catch{await store.transact(s=>{const entry=s.longInvestigationNotices[key];entry.failures++;entry.retryAt=now+Math.min(300000,5000*2**Math.min(entry.failures,6));entry.error='提醒投递失败，原任务照常执行';});}
  }
 }
}
