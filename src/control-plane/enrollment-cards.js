import {isPendingEnrollment} from '../shared/enrollment-lifecycle.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAdministrator, isTaskCreator } from './authorization.js';
import { elapsed, cumulativeToolCalls } from './message-cards.js';
export const pendingEnrollment = isPendingEnrollment;
export const enrollmentVersion = e => createHash('sha256').update(`${e.id}|${e.status}|${e.url}|${e.profile}`).digest('hex').slice(0,16);
export function enrollmentNotice(e) {
 if (!e || !["opening","login_required","scope_required"].includes(e.status)) return null;
 const message=e.status === "scope_required" ? "Nacos 登录已成功，正在等待命名空间范围选择："+(e.namespaces??[]).map(n=>n.name||n.id||"public").join("、")+"。尚未查询数据库。" : e.status === "opening" ? "正在启动本机独立登录窗口，尚未确认登录成功。" : e.loginIssue ? "登录尚未通过认证，请核对账号密码或在本机完成验证码；可在本话题重新提供凭据。" : e.credentialReceivedAt ? "已收到凭据，正在尝试自动登录，尚未确认认证成功。成功后仍需选择允许读取的命名空间。" : "等待 Nacos 登录：可在本话题 @助手 提供账号密码，由独立窗口自动填写；也可在本机手动登录。验证码和读取范围选择仍需本人完成。";
 return message+`\n\n目标：${e.tier.toUpperCase()} · ${e.url}`;
}
export function addQuestionProgress(card, state, q, enrollment, now = Date.now()) {
 const jobs=(state.jobs??[]).filter(j=>j.questionId===q.id);
 if(!jobs.length&&!enrollment)return card;
 const md=content=>({tag:'markdown',content});
 card.body.elements.push({tag:'column_set',flex_mode:'none',columns:[
  {tag:'column',width:'weighted',weight:1,elements:[md(`**${elapsed(q.createdAt, enrollment ? now : Date.parse(state.conversations.find(t=>t.id===q.latestTurnId)?.completedAt??q.createdAt))}**`),md('问题已持续（含接入等待）')]},
  {tag:'column',width:'weighted',weight:1,elements:[md(`**${jobs.reduce((n,j)=>n+cumulativeToolCalls(j.events??[]),0)} 次**`),md('累计实际工具调用')]},
 ]});
 if(enrollment) card.body.elements.push({tag:'column_set',flex_mode:'none',columns:[['enrollment_refresh','刷新状态','default'],['enrollment_cancel','停止接入与接续','danger']].map(([action,label,type])=>({tag:'column',width:'weighted',weight:1,elements:[{
  tag:'button',type,text:{tag:'plain_text',content:label},behaviors:[{type:'callback',value:{action,enrollmentId:enrollment.id,version:enrollmentVersion(enrollment)}}],
  ...(action==='enrollment_cancel'?{confirm:{title:{tag:'plain_text',content:label},text:{tag:'plain_text',content:'停止本次接入和原问题的自动接续，保留已有调查结果。确定继续？'}}}:{}),
 }]}))});
 return card;
}
function containsControl(node,value) {
 if (!node || typeof node!=="object") return false;
 if(node.type==="callback"&&node.value?.action===value.action&&node.value.enrollmentId===value.enrollmentId&&node.value.version===value.version)return true;
 return Object.values(node).some(v=>containsControl(v,value));
}
export async function handleEnrollmentCard(context,event,key,saved,value,effectiveChatId) {
 const qid=key.slice('question:'.length),{store,projects}=context;
 const effect=`${event.agent_profile}:${event.event_id}`;
 const result=await store.transact(s=>{
  if(s.enrollmentCardEffects?.[effect]) {
   const old=s.enrollmentCardEffects[effect];
   if(old.enrollmentId!==value.enrollmentId||old.action!==value.action||old.questionId!==qid||old.operatorId!==event.operator_id||old.chatId!==effectiveChatId)throw Error("回调身份不一致");
   return old;
  }
  const q=s.questions?.[qid],e=s.environmentEnrollments?.[value.enrollmentId],card=s.cardMessages?.[key];
  if(!q||!e||!pendingEnrollment(e)||q.chatId!==effectiveChatId||e.chatId!==effectiveChatId||e.questionId!==qid||e.projectId!==q.projectId||e.profile!==event.agent_profile||q.profile!==event.agent_profile
   ||card?.messageId!==event.message_id||card.destination.profile!==event.agent_profile||enrollmentVersion(e)!==value.version||!containsControl(card.card,value))throw Error('接入卡片已更新，请使用最新卡片。');
  const actor={profile:event.agent_profile,senderId:event.operator_id};
  if(!isAdministrator(projects,actor)&&!isTaskCreator(projects,q,actor))throw Error('只有本问题发起人或群主可以操作接入卡片。');
  if(value.action==='enrollment_cancel'){
   e.status='cancelled';e.cancelledAt=new Date().toISOString();e.cancelledBy=event.operator_id;
   const turn=s.conversations.find(t=>t.id===q.latestTurnId);
   if(turn){turn.setupPending=false;turn.setupCancelled=true;turn.status='ready';turn.response='本次接入已停止，原问题不会自动继续；已有调查结果保留。';turn.actionError=null;turn.sentParts=0;}
   q.generation++;
  }
  const out={ok:true,enrollmentId:e.id,questionId:qid,operatorId:event.operator_id,chatId:effectiveChatId,action:value.action,message:value.action==='enrollment_cancel'?'已停止本次接入和自动接续。':'已刷新接入状态。'};
  s.enrollmentCardEffects??={};s.enrollmentCardEffects[effect]=out;return out;
 });
 if(value.action==='enrollment_cancel'){
  const dir=path.join(context.config.dataDir,'environment-enrollments',value.enrollmentId);
  await mkdir(dir,{recursive:true,mode:0o700});await writeFile(path.join(dir,'cancelled.json'),'{}',{mode:0o600});
 }
 const {publishQuestion}=await import('./questions.js');
 try { await publishQuestion(context,qid); } catch { /* Accepted controls are not replayed on a presentation race. */ }
 context.conversations?.wake();return result;
}
