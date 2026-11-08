import {receptionKey,receptionScope,topicQuestion,receptionIdentity,publicOwnerStatus,validateOwnerStatus,captureRecoveryEvent,recoveryDiagnosis,receptionSensitive} from '../shared/reception-policy.js';
import {isAdministrator} from './authorization.js';
import {validateDecision} from './codex-conversation.js';
import {requesterMentionText} from './requester-mention.js';
import {addressText} from './reply-addressing.js';
import {messageIdOf} from './live-cards.js';
import {publishQuestion} from './questions.js';
import {loadHarness} from '../runner/harness.js';
const active=j=>['queued','running','cancelling'].includes(j?.status),iso=n=>new Date(n).toISOString();
const ids=e=>(e.mentions??[]).flatMap(m=>[m.id?.open_id??m.id?.app_id??m.id,m.open_id,m.user_id]).filter(x=>typeof x==='string');
const variants={help:['老大暂时还没接话，我先接住这条求助 👀 原卡和已有结果都留着，有新进展就在这里同步。','这条求助我记下啦，先帮你盯住原卡 👀 有确认的进展会继续在这里说，不用重新提问。','老师，我来接个班 👀 已记下这张卡的求助，接下来只沿原问题核对，不让已有结果白忙。'],reminder:['老师，这句看起来是在追加需求～@ 一下本话题的对应助手，我就能沿原问题接着处理 👀','老师，需求我看见啦。记得 @ 本话题的助手，让这句正式接上原任务，别让它混进聊天里～'],recovery:['老师，这一步没接上，我先核对中断环节，已有结果都留着。','老师，我来看看这次停在哪一步，核实后就在原卡更新。','老师，这里碰到个绊脚石，我先检查执行记录，不用重新描述问题 👀']};
export class ReceptionService{
 constructor(context,policy,{now=()=>Date.now(),intervalMs=2000,decide,verifyResume}={}){this.context=context;this.policy=policy;this.enabled=policy.enabled===true;this.now=now;this.intervalMs=intervalMs;this.decide=decide??((input,signal,options)=>context.conversations.decide(input,signal,options));this.verifyResume=verifyResume??(async j=>{if(!j.analysisSourceSnapshot?.workspace)throw Error('No fixed source snapshot');const h=await loadHarness({...j,context:[]});const old=[j.result,...(j.context??[]).map(c=>c.result)].find(r=>r?.harness?.fingerprint)?.harness;if(!old||old.fingerprint!==h.metadata.fingerprint)throw Error('Harness changed');});this.abort=new AbortController();if(this.enabled)for(const profile of policy.profiles){const senderId=receptionIdentity(context.projects,policy,profile);if(!senderId||!isAdministrator(context.projects,{senderId,profile}))throw Error('Reception owner identity must map to a trusted administrator for each profile');}}
 owner(event){const id=receptionIdentity(this.context.projects,this.policy,event.agent_profile);return Boolean(id&&id===event.sender_id&&isAdministrator(this.context.projects,{senderId:event.sender_id,profile:event.agent_profile}));}
 async direct(event){if(!this.enabled||event.chat_type!=='p2p'||!this.policy.profiles.includes(event.agent_profile)||!this.owner(event)||!['text','post',undefined].includes(event.message_type))return null;if(receptionSensitive(event.content))return {ignored:true,reason:'credential_not_public_status'};return this.context.conversations.enqueue({...event,owner_status_channel:true});}
 async observe(event,agent){
  if(!this.enabled||event.chat_type!=='group'||!receptionScope(this.policy,{profile:event.agent_profile,chatId:event.chat_id})||agent?.allowedChatIds&&!agent.allowedChatIds.includes(event.chat_id))return null;
  const mentionIds=ids(event),addressed=[agent?.openId,agent?.appId].filter(Boolean).some(id=>mentionIds.includes(id));
  if(addressed&&!this.owner(event))return null;
  const otherBots=Object.values(this.context.agents.agents??{}).flatMap(a=>[a.openId,a.appId]).filter(Boolean);if(!this.owner(event)&&mentionIds.some(id=>otherBots.includes(id)))return null;
  const known=await this.context.store.select(s=>topicQuestion(s,event));if(!known)return null;
  return this.context.store.transact(s=>{const q=topicQuestion(s,event);if(!q)return null;
   if(this.owner(event)){for(const e of Object.values(s.receptionInbox??{}))if(e.questionId===q.id&&e.profile===q.profile&&['queued','waiting'].includes(e.status)&&!e.notice?.messageId){e.status='cancelled';e.cancelReason='owner_replied';}return null;}
   if(addressed)return null;
   // A different bot mention belongs to that bot, not this topic receptionist.
   const allBots=Object.values(this.context.agents.agents??{}).flatMap(a=>[a.openId,a.appId]).filter(Boolean);if(mentionIds.some(id=>allBots.includes(id)))return null;
   const text=String(event.content??'');if(!text.trim()||event.attachments?.length||/password|passwd|密码|验证码|secret|[A-Za-z0-9!@#$%^&*]{24,}/i.test(text))return null;
   const key=receptionKey([event.agent_profile,event.chat_id,event.message_id]);s.receptionInbox??={};s.receptionInbox[key]??={key,questionId:q.id,projectId:q.projectId,profile:q.profile,chatId:q.chatId,senderId:event.sender_id,replyTo:event.message_id,topicReplyTo:q.messageId,generation:q.generation,content:text,ownerMentioned:mentionIds.includes(receptionIdentity(this.context.projects,this.policy,q.profile)),status:'queued',createdAt:iso(this.now())};return {ignored:true,reason:'reception_only',receptionKey:key};
  });
 }
 statusInput(s){return publicOwnerStatus(s,this.policy,this.now());}
 async setOwnerStatus(turn,value){
  if(!this.enabled||!turn.ownerStatusChannel||!this.owner({agent_profile:turn.profile,sender_id:turn.senderId}))throw Error('Only configured administrator may set shared presence by DM');validateOwnerStatus(value,this.now());
  return this.context.store.transact(s=>{s.ownerPresence??={};const previous=s.ownerPresence[this.policy.humanId];s.ownerPresence[this.policy.humanId]={...value,updatedAt:iso(this.now()),sourceMessageId:turn.messageId,updatedBy:{profile:turn.profile,senderId:turn.senderId},version:(previous?.version??0)+1};return {notice:`已同步给${this.policy.profiles.length}位助手：${value.available?'恢复正常接待':value.publicText||'暂时不方便及时回复'}。状态有效至 ${value.expiresAt}；未授权公开的信息不会对外说明。`};});
 }
 start(){if(!this.enabled)return;this.context.store.transact(s=>{for(const e of Object.values(s.recoveryEvents??{}))if(e.status==='diagnosing')e.status='queued';}).then(()=>this.tick()).catch(()=>{});this.timer=setInterval(()=>this.tick().catch(()=>console.error('[reception] reconciliation deferred')),this.intervalMs);this.timer.unref();}
 async close(){this.closed=true;clearInterval(this.timer);this.abort.abort();await this.running;}
 async tick(){if(this.closed||!this.enabled)return;if(this.running)return this.running;this.running=this.run();try{await this.running;}finally{this.running=null;}}
 valid(s,e){const q=s.questions?.[e.questionId];return q&&!q.closedAt&&q.visibility!=='requester'&&q.profile===e.profile&&q.chatId===e.chatId&&q.projectId===e.projectId&&(e.generation===undefined||q.generation===e.generation)&&receptionScope(this.policy,e);}
 async classify(entry){
  const result=validateDecision(await this.decide({requestId:entry.key,nativeSession:false,role:'owner_intake',message:entry.content,history:[],jobs:[],attachments:[],currentAttachmentIds:[],project:{id:entry.projectId},channel:{kind:'reception_only',ownerMentioned:entry.ownerMentioned,allowedActions:['reply'],rule:'仅分类，不启动业务、不调用工具；未@管理员不能分类owner_help。普通讨论/收到/我看看/闲聊为ignore。'},publicOwnerStatus:this.statusInput(await this.context.store.read())},this.abort.signal,{sessionKey:'reception:'+entry.key}));
  if(result.action!=='reply'||result.intent!=='none'||result.requiresSourceInspection||result.environmentQuery||result.environmentSetup||result.attachmentIds.length)throw Error('Reception cannot execute business actions');
  const kind=result.receptionIntent??'ignore';return kind==='owner_help'&&!entry.ownerMentioned?'ignore':kind;
 }
 async view(){return this.context.store.select(s=>{const questions=Object.fromEntries(Object.entries(s.questions??{}).filter(([,q])=>receptionScope(this.policy,q))),ids=new Set(Object.keys(questions));return {questions,ownerPresence:s.ownerPresence,receptionInbox:s.receptionInbox??{},recoveryEvents:s.recoveryEvents??{},reportDeliveries:Object.fromEntries(Object.entries(s.reportDeliveries??{}).filter(([,e])=>ids.has(e.questionId)&&!e.messageId&&!e.superseded&&e.failures>0)),jobs:s.jobs.filter(j=>ids.has(j.questionId)).map(j=>({id:j.id,senderId:j.senderId,questionId:j.questionId,projectId:j.projectId,originProfile:j.originProfile,agentProfile:j.agentProfile,originChatType:j.originChatType,visibility:j.visibility,status:j.status,taskIntent:j.taskIntent,updatedAt:j.updatedAt,nextJobId:j.nextJobId,result:{outcome:j.result?.outcome,executionFailure:j.result?.executionFailure,environmentFailure:j.result?.environmentFailure,queryRejection:j.result?.queryRejection,browserLoginRequired:j.result?.browserLoginRequired,modelCapacityWaiting:j.result?.modelCapacityWaiting},...(j.environmentAccess?{environmentAccess:true}:{})}))};});}
 async run(){
  let state=await this.view();const now=this.now();
  for(const entry of Object.values(state.receptionInbox??{})){
   if(!['queued','waiting','reminding'].includes(entry.status)||entry.retryAt>now)continue;
   if(!this.valid(state,entry)){await this.patchInbox(entry.key,{status:'cancelled',cancelReason:'scope_closed_or_changed'});continue;}
   if(entry.status==='queued'){
    try{const kind=await this.classify(entry);await this.context.store.transact(s=>{const e=s.receptionInbox?.[entry.key];if(!e||e.status!=='queued'||!this.valid(s,e))return;const others=Object.values(s.receptionInbox??{}).filter(x=>x.key!==e.key&&x.profile===e.profile&&x.questionId===e.questionId);if(kind==='ignore'){e.status='ignored';return;}if(kind==='owner_help'){if(others.some(x=>x.status==='waiting'||x.kind==='owner_help'&&x.notice?.messageId&&now-Date.parse(x.notice.deliveredAt)<this.policy.reminderCooldownMs)){e.status='coalesced';return;}e.kind=kind;e.status='waiting';e.dueAt=Date.parse(e.createdAt)+this.policy.helpDelayMs;}else{if(others.some(x=>x.kind==='needs_mention'&&x.notice?.messageId&&now-Date.parse(x.notice.deliveredAt)<this.policy.reminderCooldownMs)){e.status='coalesced';return;}e.kind='needs_mention';e.status='reminding';e.dueAt=now;}});}catch{await this.patchInbox(entry.key,{retryAt:now+15000,error:'接待分类暂不可用，未执行任何业务动作'});}
   }
  }
  state=await this.view();
  for(const entry of Object.values(state.receptionInbox??{}))if(['waiting','reminding'].includes(entry.status)&&entry.dueAt<=now&&!entry.notice?.messageId&&!(entry.retryAt>now)){
   if(!this.valid(state,entry)){await this.patchInbox(entry.key,{status:'cancelled'});continue;}
   const jobs=state.jobs.filter(j=>j.questionId===entry.questionId),latest=jobs.at(-1);
   if(entry.kind==='owner_help'&&latest?.status==='completed'&&latest.result?.outcome==='ready'&&Date.parse(latest.updatedAt)>Date.parse(entry.createdAt)){await this.patchInbox(entry.key,{status:'cancelled',cancelReason:'task_resolved'});continue;}
   const presence=this.statusInput(state),text=this.text(entry.kind==='needs_mention'?'reminder':entry.kind==='recovery'?'recovery':'help',entry.key)+(presence&&!presence.available&&presence.publicText?`\n老大已提前说明：${presence.publicText}`:'');
   await this.sendInbox(entry,text);
  }
  // Reconcile only failures occurring after explicit activation. Never revive legacy cards.
  const missing=state.jobs.filter(j=>Date.parse(j.updatedAt)>=Date.parse(this.policy.since)&&['blocked','failed','awaiting_clarification'].includes(j.status)&&!Object.values(state.recoveryEvents).some(e=>e.jobId===j.id&&e.failureAt===j.updatedAt));
  if(missing.length)await this.context.store.transact(s=>{for(const candidate of missing){const j=s.jobs.find(x=>x.id===candidate.id);if(j)captureRecoveryEvent(s,j,this.policy);}});
  state=await this.view();
  for(const [key,delivery]of Object.entries(state.reportDeliveries??{})){
   if(Date.parse(delivery.createdAt)<Date.parse(this.policy.since))continue;const q=state.questions[delivery.questionId],job=state.jobs.filter(j=>j.questionId===q?.id).at(-1);if(!q||!job)continue;const eventKey=receptionKey(['delivery',q.profile,q.id,key]);if(state.recoveryEvents[eventKey])continue;const e={key:eventKey,jobId:job.id,questionId:q.id,profile:q.profile,projectId:q.projectId,chatId:q.chatId,replyTo:q.messageId,generation:q.generation,status:'delegated',createdAt:iso(now),diagnosis:{kind:'delivery',action:'existing_file_outbox',message:'文件已保存，正在沿原文件和原幂等投递记录恢复发送，不重新查询业务数据。'}};await this.context.store.transact(s=>{s.recoveryEvents??={};s.recoveryEvents[eventKey]??=e;});await this.recoveryNotice(e,e.diagnosis,false);
  }
  for(const e of Object.values(state.recoveryEvents??{})){
   if(!this.valid(state,e)||e.status!=='queued')continue;const job=await this.context.store.getJob(e.jobId);
   if(!job||job.updatedAt!==e.failureAt||active(job)||!['blocked','failed','awaiting_clarification'].includes(job.status)){await this.patchRecovery(e.key,{status:'superseded'});continue;}
   await this.patchRecovery(e.key,{status:'diagnosing',diagnosedAt:iso(now)});
   const diagnosis=recoveryDiagnosis(job);
   let actionTaken=false;
   if(diagnosis.action==='resume_unstarted_source')try{
    await this.verifyResume(job);
    actionTaken=await this.context.store.transact(s=>{const j=s.jobs.find(x=>x.id===job.id),r=s.recoveryEvents[e.key],q=s.questions[e.questionId];if(!this.valid(s,e)||j.updatedAt!==e.failureAt||active(j)||j.environmentAccess||j.reportFiles?.length||s.conversations.some(t=>t.questionId===q.id&&['queued','thinking','decided','ready'].includes(t.status)))return false;
     j.receptionRecoveryHistory??=[];j.receptionRecoveryHistory.push({at:iso(now),result:j.result,eventKey:e.key});j.status='queued';j.result=null;j.lease=null;j.updatedAt=iso(now);j.events.push({type:'reception_startup_read_resumed',at:iso(now),eventKey:e.key});q.generation++;r.failureGeneration=r.generation;r.generation=q.generation;r.status='resumed';r.action='same_source_startup_read';return true;});
   }catch{diagnosis.message='启动恢复的原范围或规范检查未通过，未重放任务；已保留证据等待维护复核。';}
   if(!actionTaken)await this.patchRecovery(e.key,{status:diagnosis.action.startsWith('existing_')?'delegated':'maintenance_required',diagnosis,action:diagnosis.action});
   await this.recoveryNotice((await this.view()).recoveryEvents[e.key],diagnosis,actionTaken);
   if(this.context.cards?.enabled)await publishQuestion(this.context,e.questionId);
  }
 }
 text(kind,key){const pool=variants[kind];return pool[parseInt(key.slice(0,8),16)%pool.length];}
 async patchInbox(key,fields){await this.context.store.transact(s=>{if(s.receptionInbox?.[key])Object.assign(s.receptionInbox[key],fields);});}
 async patchRecovery(key,fields){await this.context.store.transact(s=>{if(s.recoveryEvents?.[key])Object.assign(s.recoveryEvents[key],fields);});}
 async sendInbox(entry,text){
  const fresh=await this.context.store.read(),e=fresh.receptionInbox?.[entry.key];if(!e||!this.valid(fresh,e)||!['waiting','reminding'].includes(e.status)||e.notice?.messageId)return;
  const name=e.notice?'':await this.context.replyAddressing?.forTurn({...e,chatType:'group'})??'';
  const addressed=name?addressText(text.replace(/^老师，/,''),name):text;
  const notice=e.notice??{text:requesterMentionText(e.senderId,addressed),replyTo:e.replyTo,idempotencyKey:'aos-reception-'+e.key.slice(0,32),firstAttemptAt:this.now()};
  if(!notice.text){await this.patchInbox(e.key,{status:'reconciliation_required',error:'提问者身份格式无法核验，未发送接待消息'});return;}
  if(this.now()-notice.firstAttemptAt>=55*60000){await this.patchInbox(e.key,{status:'reconciliation_required'});return;}
  await this.patchInbox(e.key,{notice});
  try{const r=await this.context.feishu.reply(notice.replyTo,notice.text,{profile:e.profile,replyInThread:true,idempotencyKey:notice.idempotencyKey}),id=messageIdOf(r);if(!id)throw Error('No receipt');await this.patchInbox(e.key,{status:'sent',notice:{...notice,messageId:id,deliveredAt:iso(this.now())}});}catch{await this.patchInbox(e.key,{retryAt:this.now()+15000,error:'接待投递失败，仅重试同一消息'});}
 }
 async recoveryNotice(e,diagnosis,resumed){
  const state=await this.view(),job=state.jobs.find(j=>j.id===e.jobId);if(!job||!this.valid(state,e))return;
  const key=receptionKey(['recovery',e.profile,e.questionId,e.failureGeneration??e.generation,diagnosis.kind]);
  if(state.receptionInbox?.[key])return;
  const text=this.text('recovery',key)+'\n'+diagnosis.message+(resumed?'\n已接回原任务继续执行。':diagnosis.action==='maintenance_required'?'\n这次已登记为待维护复核，尚未声称修复完成。':'');
  await this.context.store.transact(s=>{s.receptionInbox??={};s.receptionInbox[key]??={...e,key,senderId:job.senderId,replyTo:e.replyTo,kind:'recovery',status:'reminding',dueAt:this.now(),createdAt:iso(this.now())};});
  await this.sendInbox((await this.context.store.read()).receptionInbox[key],text);
 }
}
