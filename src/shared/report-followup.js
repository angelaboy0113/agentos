import {reportFile} from './report-files.js';
import {hashFile} from './file-digest.js';
import {stateView,questionStateView} from './state-view.js';

// Generated files are task inputs, never shared knowledge or new database authority.
export function visibleReportJobs(state, actor, projectId) {
 const ids=new Set();let q=state.questions?.[actor.questionId];
 while(q&&!ids.has(q.id)&&q.chatId===actor.chatId&&q.profile===(actor.profile??actor.originProfile)&&q.projectId===projectId
  &&(q.visibility!=='requester'||actor.visibility==='requester'&&q.senderId===actor.senderId)){
  ids.add(q.id);q=state.questions?.[q.parentQuestionId];
 }
 return (state.jobs??[]).filter(j=>ids.has(j.questionId)&&j.chatId===actor.chatId&&j.projectId===projectId
  &&(j.originProfile??j.agentProfile)===(actor.profile??actor.originProfile)
  &&(j.visibility!=='requester'||actor.visibility==='requester'&&j.senderId===actor.senderId));
}

export async function deliveredReportInputs(state,actor,projectId,dataDir,{attachmentId}={}){
 const jobs=visibleReportJobs(state,actor,projectId),inputs=[],unavailable=[];
 for(const entry of Object.values(state.reportDeliveries??{})){
  if(!entry.messageId||!jobs.some(j=>j.id===entry.sourceJobId)||!entry.item)continue;
  const id='delivered-'+entry.sourceJobId+'-'+entry.item.id;
  if(attachmentId&&id!==attachmentId)continue;
  const job=jobs.find(j=>j.id===entry.sourceJobId),item=job.reportFiles?.find(f=>f.id===entry.item.id&&f.sha256===entry.item.sha256&&f.verificationHash===entry.item.verificationHash);
  if(!item)continue;
  if(job.archivedAt){
   unavailable.push({fileId:item.id,sourceJobId:job.id,reason:'本地交付缓存已归档。原文件仍可从飞书投递消息打开；需要按当前数据重查时请发起新调查。'});
   continue;
  }
  try{
   const {file}=await reportFile(dataDir,entry.sourceJobId,item,{includeContent:false});
   if(inputs.some(a=>a.id===id))continue;
   inputs.push({id,type:'file',contentType:item.contentType??'text/csv',path:file,filename:item.filename,
    source:{kind:'delivered-report',sha256:item.sha256,sourceJobId:entry.sourceJobId,report:structuredClone(item),
     projectId,originProfile:actor.profile??actor.originProfile,chatId:actor.chatId,questionId:job.questionId,
     sourceEnvironment:job.sourceEnvironment??null,deliveredAt:entry.deliveredAt??null}});
  }catch{unavailable.push({fileId:item.id,sourceJobId:job.id,reason:'原交付文件或核验记录缺失/损坏；保留引用，不能声称用户没有提供文件或自动重查业务。'});}
 }
 return {inputs,unavailable};
}

function sharedReportContext(state, actor, projectId, sourceJobId) {
 const profile=actor.profile??actor.originProfile;
 const jobs=(state.jobs??[]).filter(job=>
  (!sourceJobId||job.id===sourceJobId)&&!job.archivedAt&&job.visibility!=='requester'&&
  state.questions?.[job.questionId]?.visibility!=='requester'&&job.chatId===actor.chatId&&
  job.projectId===projectId&&(job.originProfile??job.agentProfile)===profile&&job.reportFiles?.length)
  .map(({id,questionId,sourceEnvironment,reportFiles})=>({id,questionId,sourceEnvironment,reportFiles}));
 const byId=new Map(jobs.map(job=>[job.id,job]));
 const reportDeliveries=Object.values(state.reportDeliveries??{}).filter(entry=>entry.messageId&&
  entry.destination?.profile===profile&& !entry.destination?.privateRecipient&&
  entry.item?.filename?.endsWith('.csv')&&byId.get(entry.sourceJobId)?.reportFiles?.some(file=>
   file.id===entry.item.id&&file.sha256===entry.item.sha256&&file.verificationHash===entry.item.verificationHash));
 return {jobs,reportDeliveries};
}

// A message attachment is evidence only when its bytes match an already delivered
// public CSV in the same chat and assistant. Never recover by filename or cross scope.
async function uploadedBinding({jobs,reportDeliveries},actor,projectId,dataDir,attachment) {
 if(attachment.type!=='file'||!attachment.path?.toLowerCase().endsWith('.csv'))return null;
 const sha256=await hashFile(attachment.path).catch(()=>null);
 if(!sha256)return null;
 const byId=new Map(jobs.map(job=>[job.id,job]));
 for(const entry of reportDeliveries.filter(entry=>entry.item.sha256===sha256).toReversed()){
  const job=byId.get(entry.sourceJobId);
  const item=job.reportFiles.find(file=>file.id===entry.item.id);
  try{
   const {file}=await reportFile(dataDir,job.id,item,{includeContent:false});
   return {file,source:{kind:'delivered-report',uploadedCopy:true,sha256,sourceJobId:job.id,
    report:structuredClone(item),projectId,originProfile:actor.profile??actor.originProfile,chatId:actor.chatId,
    questionId:job.questionId,sourceEnvironment:job.sourceEnvironment??null,deliveredAt:entry.deliveredAt??null}};
  }catch{}
 }
 return null;
}

export async function bindReattachedReports(store,actor,projectId,dataDir,attachments) {
 if(!attachments.some(a=>!a.source&&a.type==='file'&&a.path?.toLowerCase().endsWith('.csv')))return attachments;
 const context=await stateView(store,state=>sharedReportContext(state,actor,projectId));
 return Promise.all(attachments.map(async attachment=>{
  if(attachment.source)return attachment;
  const binding=await uploadedBinding(context,actor,projectId,dataDir,attachment);
  return binding?{...attachment,filename:binding.source.report.filename,source:binding.source}:attachment;
 }));
}

export async function boundReportInput(store,job,attachment,dataDir){
 if(attachment.source?.uploadedCopy){
  const context=await stateView(store,state=>sharedReportContext(state,job,job.projectId,attachment.source.sourceJobId));
  const current=await uploadedBinding(context,job,job.projectId,dataDir,attachment);
  if(current&&JSON.stringify(current.source)===JSON.stringify(attachment.source))return {file:current.file};
  throw new Error('重传的CSV摘要或原公开交付范围已变化');
 }
 const state=await questionStateView(store,job);
 const current=await deliveredReportInputs(state,{...job,profile:job.originProfile??job.agentProfile},job.projectId,dataDir,{attachmentId:attachment.id});
 const item=current.inputs.find(a=>a.id===attachment.id&&JSON.stringify(a.source)===JSON.stringify(attachment.source));
 if(!item)throw new Error('原交付文件不再属于当前机器人、群、可见问题链或已交付回执');
 return {file:item.path};
}
