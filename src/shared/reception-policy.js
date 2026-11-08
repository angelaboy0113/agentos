import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const receptionKey=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function loadReceptionPolicy(file){let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'||!file)return{enabled:false};throw e;}return validateReceptionPolicy(value);}
export function validateReceptionPolicy(v){
 if(!v||typeof v.enabled!=='boolean')throw Error('Invalid reception policy');if(!v.enabled)return {enabled:false};
 if(!Array.isArray(v.profiles)||!v.profiles.length||v.profiles.some(x=>typeof x!=='string'||!x)||!Array.isArray(v.chatIds)||!v.chatIds.length||v.chatIds.some(x=>typeof x!=='string'||!x)||typeof v.humanId!=='string'||!Number.isFinite(Date.parse(v.since))||!Number.isSafeInteger(v.helpDelayMs)||v.helpDelayMs<0||!Number.isSafeInteger(v.reminderCooldownMs)||v.reminderCooldownMs<0)throw Error('Invalid reception scope');
 try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone});}catch{throw Error('Invalid reception time zone');}
 return {...v};
}
export function receptionScope(policy,record){return Boolean(policy?.enabled&&policy.profiles.includes(record.profile??record.originProfile??record.agentProfile)&&policy.chatIds.includes(record.chatId)&&record.visibility!=='requester');}
export function topicQuestion(s,event){const refs=[event.reply_to,event.root_id].filter(Boolean);if(!refs.length)return null;
 return Object.values(s.questions??{}).reverse().find(q=>q.profile===event.agent_profile&&q.chatId===event.chat_id&&q.visibility!=='requester'&&!q.closedAt&&refs.some(ref=>q.messageId===ref||q.threadRootId===ref||s.cardMessages?.['question:'+q.id]?.messageId===ref||(s.conversations??[]).some(t=>t.questionId===q.id&&(t.messageId===ref||t.responseIds?.includes(ref)))));
}
export function receptionIdentity(projects,policy,profile){return projects.humanIdentities?.[policy.humanId]?.[profile]??null;}
export function publicOwnerStatus(s,policy,now=Date.now()){const v=s.ownerPresence?.[policy.humanId];return v&&Date.parse(v.expiresAt)>now?{available:v.available,publicText:v.publicText,expiresAt:v.expiresAt,timeZone:policy.timeZone}:null;}
export function validateOwnerStatus(value,now=Date.now()){
 if(!value||typeof value.available!=='boolean'||typeof value.publicText!=='string'||value.publicText.length>500||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now||!/(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt)||Object.keys(value).some(k=>!['available','publicText','expiresAt'].includes(k)))throw Error('需要明确未来失效时间（含时区）、是否方便回复及可公开的短说明；未保存状态。');
 if(/(?:password|passwd|token|secret|密码|验证码|身份证|手机号)\s*[:：=]/i.test(value.publicText))throw Error('状态不能保存凭据或敏感字段');return value;
}
export function recoveryDiagnosis(job){
 const r=job.result??{},failure=r.executionFailure??r.environmentFailure??{},code=failure.code??r.queryRejection?.code??'UNCLASSIFIED',stage=failure.rpcMethod??failure.stage??failure.tool??'';
 if(r.browserLoginRequired)return {kind:'login',action:'existing_login_recovery',message:'正在复用原网站登录态和已保存凭据；人工验证或明确认证失败会保留具体提示。'};
 if(r.modelCapacityWaiting)return {kind:'capacity',action:'existing_checkpoint_recovery',message:'模型服务暂时繁忙，沿已保存的检查点等待恢复，不重跑已完成查询。'};
 if(job.taskIntent==='analysis'&&!job.environmentAccess&&code==='CODEX_RPC_TIMEOUT'&&['account/read','initialize'].includes(stage))return {kind:'safe_startup',action:'resume_unstarted_source',message:'本机模型登录读取暂时超时，模型业务执行尚未开始；核验原范围后恢复当前启动步骤。'};
 if(code==='TIMEOUT')return{kind:'query_timeout',action:'maintenance_required',message:'当前读取超时；保留已取得数据与原始错误，需要核对具体查询步骤，不盲目重放整项任务。'};
 if(/SCOPE|AUTH|PERMISSION|FORBIDDEN|CREDENTIAL|TLS/.test(code)||r.queryRejection)return{kind:'access',action:'maintenance_required',message:'需要核对当前步骤的访问范围或认证状态；不会自动扩大权限，也不把它当成业务结论。'};
 return {kind:'program_or_evidence',action:'maintenance_required',message:'正在核对执行环节与已保存证据；当前尚不能自动确认修复，需要维护复核，原结果继续保留。'};
}
export function captureRecoveryEvent(s,job,policy,event={}){
 const q=s.questions?.[job.questionId];if(!q||!receptionScope(policy,{...job,profile:job.originProfile??job.agentProfile})||q.profile!==(job.originProfile??job.agentProfile)||q.chatId!==job.chatId||q.projectId!==job.projectId||q.visibility==='requester'||q.closedAt||job.originChatType!=='group'||job.taskIntent!=='analysis'||job.nextJobId||Date.parse(job.updatedAt)<Date.parse(policy.since))return;
 if(!['blocked','failed'].includes(job.status)&&!(job.status==='awaiting_clarification'&&(job.result?.browserLoginRequired||job.result?.modelCapacityWaiting)))return;
 if((s.jobs??[]).filter(j=>j.questionId===q.id).at(-1)?.id!==job.id)return;
 const prior=Object.values(s.recoveryEvents??{}).find(e=>e.jobId===job.id&&e.failureAt===job.updatedAt);if(prior)return prior.key;
 const key=receptionKey([q.profile,q.chatId,q.projectId,q.id,job.id,event.id??job.updatedAt]);s.recoveryEvents??={};s.recoveryEvents[key]??={key,jobId:job.id,questionId:q.id,profile:q.profile,projectId:q.projectId,chatId:q.chatId,replyTo:q.messageId,generation:q.generation,failureAt:job.updatedAt,status:'queued',createdAt:job.updatedAt,diagnosis:recoveryDiagnosis(job)};return key;
}
export function directSocial(turn){const d=turn.decision;return turn.ownerStatusChannel||turn.visibility!=='requester'&&d?.responseStyle==='social'&&d.action==='reply'&&d.intent==='none'&&!d.requiresSourceInspection&&!d.environmentQuery&&!d.environmentSetup&&!d.contactLookup&&!d.attachmentIds?.length&&!d.requiresTabularDelivery;}
