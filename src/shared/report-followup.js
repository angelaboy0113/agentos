import {reportFile} from './report-files.js';

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

export async function boundReportInput(state,job,attachment,dataDir){
 const current=await deliveredReportInputs(state,{...job,profile:job.originProfile??job.agentProfile},job.projectId,dataDir,{attachmentId:attachment.id});
 const item=current.inputs.find(a=>a.id===attachment.id&&JSON.stringify(a.source)===JSON.stringify(attachment.source));
 if(!item)throw new Error('原交付文件不再属于当前机器人、群、可见问题链或已交付回执');
 return {file:item.path};
}
