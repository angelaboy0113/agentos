import {planQuery,compactCatalog,catalog} from '../shared/environment-access.js';

// Only the current project's already configured database reads may be proposed.
// The controller still issues a fresh grant and verifies the source/runtime tier.
export function continuationCatalog(config,plan,job){
  if(!job?.continuousInvestigation||job.taskIntent!=='analysis'||job.projectId!==plan.projectId)return [];
  return catalog(config,job.projectId).filter(e=>e.tier===plan.tier&&['mysql','mongodb'].includes(e.kind)).flatMap(e=>{
    const queries=e.queries.filter(q=>q.mode==='investigate'&&(()=>{try{return !planQuery(config,{environmentId:e.environmentId,queryId:q.queryId,parameters:plan.parameters},job.projectId,{profile:job.originProfile??job.agentProfile,senderId:job.senderId}).approvalRequired;}catch{return false;}})());
    return queries.length?[{...e,queries}]:[];
  });
}
export function continuationSpec(entries){return entries.length?[{
  tool:'continue_environment',args:{environmentId:'exact next database environmentId in continuationCatalog',queryId:'exact queryId',parameters:['brief single-line purpose with known tables, keys, filters and formulas']},
  description:'当前来源已取得成果，剩余目标需要另一个已登记数据库且规则/参数已明确时，直接申请同问题下一步。先保存完整数据集；程序关闭当前步骤后重新校验范围和权限，再领取下一步，不执行本工具中的数据库查询。不能用于猜口径、切换系统/测试生产、修复尚未解决的工具失败或声明原问题完成。源码不足时finish complete=false返回源码调查。'
}]:[];}
export function validateContinuation(config,plan,job,args){
  const entries=continuationCatalog(config,plan,job),entry=entries.find(e=>e.environmentId===args?.environmentId);
  if(!entry?.queries.some(q=>q.queryId===args.queryId))throw new Error('下一步仅能选择同系统同环境已登记的数据库只读模板');
  const request={environmentId:args.environmentId,queryId:args.queryId,parameters:args.parameters,goalIds:null};
  const grant=planQuery(config,request,job.projectId,{profile:job.originProfile??job.agentProfile,senderId:job.senderId});
  if(grant.approvalRequired)throw new Error('下一步仍需实际授权');
  return request;
}
export const publicContinuationCatalog=entries=>compactCatalog(entries);

// An accepted result is persisted before this is considered. Restart uses that
// same record; failures and files always return to the ordinary source review.
export function continuationSourceResult(job){
  if(job.environmentAccess||!job.continuousInvestigation||job.taskIntent!=='analysis'||job.stage!=='developer')return null;
  const last=job.context?.at(-1);
  if(last?.kind!=='environment_result')return null;
  const result=last.result;
  if(!result?.nextEnvironmentQuery||!['partial','ready'].includes(result.outcome)||result.environmentFailure||result.exportFiles?.length||result.toolInputErrors?.some(e=>!e.resolved))return null;
  const source=[...(job.context??[])].reverse().find(x=>x.kind==='analysis_turn'&&x.result?.handoffGate?.passed===true)?.result;
  if(!source||source.sourceQuestionId!==job.questionId||!source.workspace||source.workspace!==source.sourceSync?.workspace||source.investigation?.blocker)return null;
  return {...source,outcome:'needs_clarification',environmentQuery:result.nextEnvironmentQuery,websiteQuery:null,environmentSetup:null,
    environmentContinuation:true,summary:'保留已核验源码与已保存数据，直接接续同问题已明确的数据库步骤；完整目标仍待最终审阅。'};
}
