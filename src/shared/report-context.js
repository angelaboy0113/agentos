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
