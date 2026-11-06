import {questionContextIds} from './question-context.js';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {reportEligible} from './report-acceptance.js';
import {reportFile} from './report-files.js';

export function deliveredReport(state, job, file) {
  const delivery = state.reportDeliveries?.[job.id + ':' + file.id];
  return delivery?.deliveredAt && delivery.messageId && delivery.sourceJobId === job.id
    && delivery.item?.sha256 === file.sha256 && delivery.item?.verificationHash === file.verificationHash
    && !delivery.destination?.privateRecipient && delivery.destination?.profile === (job.originProfile ?? job.agentProfile)
    ? delivery : null;
}
export async function reportConversationContext(dataDir, state, job, actor = job) {
  return Promise.all((job.reportFiles ?? []).filter(file => reportEligible(job, file) && (actor.senderId === job.senderId || job.status === 'completed' && deliveredReport(state, job, file))).map(async file => {
    const delivery = deliveredReport(state, job, file);
    let available = false;
    try { await reportFile(dataDir, job.id, file, {includeContent:false}); available = true; } catch { /* Preserve a truthful missing-file reference. */ }
    return {fileId:file.id, filename:file.filename, rowCount:file.rowCount, sha256:file.sha256,
      sourceJobId:job.id, delivered:Boolean(delivery), messageId:delivery?.messageId ?? null,
      availability:available ? 'available' : 'unavailable',
      rule:available ? '本程序已核验的报表文件；用受控复用工具读取实际列和完整来源，不要索要重复上传。'
        : '文件引用保留，但本机内容未通过检查；先恢复来源或重新导出，不能声称已读或完成。'};
  }));
}

// A checked historical input is not a newly produced artifact of this job.
export async function historicalReportReference(dataDir, job, name) {
  if(job.taskIntent!=='analysis'||!job.questionId)return null;
  const state=JSON.parse(await readFile(path.join(dataDir,'agentos.json'),'utf8'));
  const current=state.jobs?.find(candidate=>candidate.id===job.id);
  const identity=item=>[item.id,item.projectId,item.chatId,item.senderId,item.originProfile??item.agentProfile,item.sourceEnvironment??null,item.questionId];
  if(!current||current.taskIntent!=='analysis'||JSON.stringify(identity(current))!==JSON.stringify(identity(job)))return null;
  const ancestry=questionContextIds(state,current),matches=[];
  for(const source of state.jobs??[]){
    if(source.id===job.id||source.status!=='completed'||source.taskIntent!=='analysis'||!ancestry.has(source.questionId)
      ||source.projectId!==job.projectId||source.chatId!==job.chatId
      ||(source.originProfile??source.agentProfile)!==(job.originProfile??job.agentProfile)
      ||(source.sourceEnvironment??null)!==(job.sourceEnvironment??null))continue;
    const privateSource=source.visibility==='requester'||state.questions?.[source.questionId]?.visibility==='requester';
    if(privateSource&&(current.visibility!=='requester'||source.senderId!==job.senderId))continue;
    for(const file of source.reportFiles??[]){
      if(![file.id,file.filename].includes(name)||!reportEligible(source,file))continue;
      if(source.senderId!==job.senderId&&(privateSource||!deliveredReport(state,source,file)))continue;
      matches.push({source,file});
    }
  }
  if(matches.length!==1)return null;
  const {source,file}=matches[0];await reportFile(dataDir,source.id,file,{includeContent:false});
  return {kind:'report',path:file.filename,namespace:'historical-report-reference',referenceOnly:true,
    fileId:file.id,sourceJobId:source.id,sha256:file.sha256,bytes:file.bytes,verificationHash:file.verificationHash};
}
