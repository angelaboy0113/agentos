import {readFile,lstat,realpath} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
// Operator-created local request, not a model tool or automatic time/call cutoff.
// Consulted only before a new analysis worker begins, never within an active read.
export async function maintenanceCheckpoint(job,config){
 if(job.taskIntent!=='analysis'||!job.continuousInvestigation||job.stage!=='developer'||job.environmentAccess||!config.dataDir)return null;
 const file=path.join(config.dataDir,'maintenance','checkpoints.json');let request;
 try{const info=await lstat(file),root=await realpath(config.dataDir),actual=await realpath(file);if(!info.isFile()||info.isSymbolicLink()||!actual.startsWith(root+path.sep))return null;const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1||!Array.isArray(value.requests))return null;request=value.requests.find(r=>r.jobId===job.id&&typeof r.requestId==='string'&&/^[a-zA-Z0-9_-]+$/.test(r.requestId));}catch{return null;}
 if(!request)return null;
 const previous=[...(job.context??[])].reverse().find(x=>x.kind==='analysis_turn'&&x.result?.handoffGate?.passed===true)?.result;
 if(!previous)return null;
 const summary='本机维护检查点已保存已有文件与证据；升级后自动接续原问题，无需用户补充或重发。';
 return {...previous,outcome:'needs_clarification',summary,finalMessage:summary,environmentQuery:null,websiteQuery:null,environmentSetup:null,sourceEnvironmentQuery:null,reportAssessment:null,
  maintenanceCheckpoint:{requestId:request.requestId,at:new Date().toISOString(),originalQuestionHash:createHash('sha256').update(job.originalQuestion??'').digest('hex')},
  investigation:{...previous.investigation,status:'wait',goals:(previous.investigation?.goals??[]).map(g=>g.id==='original-question'?{...g,status:'open'}:g),nextStep:'完成本机受控升级后按原问题自动接续',blocker:{kind:'unavailable',needed:'本机维护自动接续',evidence:'由本机维护者明确申请，在新的源码分析步骤开始前暂存，未执行本轮模型或业务查询'}}};
}
// Run only while this instance is stopped, using the new code. No fake user
// clarification, file acceptance, result promotion or business query is created.
export async function resumeMaintenanceCheckpoint(store,{jobId,requestId}){
 return store.transact(state=>{
  const job=state.jobs.find(j=>j.id===jobId),checkpoint=job?.result?.maintenanceCheckpoint;
  if(job?.status!=='awaiting_clarification'||checkpoint?.requestId!==requestId||checkpoint.originalQuestionHash!==createHash('sha256').update(job.originalQuestion??'').digest('hex'))throw Error('Maintenance checkpoint mismatch');
  job.maintenanceRecoveries??=[];job.maintenanceRecoveries.push({requestId,at:new Date().toISOString(),action:'resume_original_scope',previousStatus:job.status});
  job.status='queued';delete job.lease;job.instruction=job.originalQuestion;
  job.events.push({id:'maintenance-'+requestId,type:'maintenance_resumed',at:new Date().toISOString(),requestId});job.updatedAt=new Date().toISOString();return {jobId:job.id,resumed:true,requestId};
 });
}
