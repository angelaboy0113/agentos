import {taskReadEnvironments,planTaskRead,assertTaskReadScope} from '../shared/integration-peers.js';
import {planQuery,compactCatalog,catalog} from '../shared/environment-access.js';

// Preserve the original task identity while proposing registered own/peer reads.
// The controller still issues a fresh grant and verifies the source/runtime tier.
export function continuationCatalog(config,plan,job,projects=null){
  if(!job?.continuousInvestigation||job.taskIntent!=='analysis'||!projects&&job.projectId!==plan.projectId)return [];
  if(projects){try{assertTaskReadScope(projects,job,config,plan);}catch{return [];}}
  return (projects?taskReadEnvironments(config,projects,job):catalog(config,job.projectId)).filter(e=>e.tier===plan.tier&&['mysql','mongodb'].includes(e.kind)).flatMap(e=>{
    const queries=e.queries.filter(q=>q.mode==='investigate'&&(()=>{try{return !(projects?planTaskRead(config,projects,job,{environmentId:e.environmentId,queryId:q.queryId,parameters:plan.parameters}):planQuery(config,{environmentId:e.environmentId,queryId:q.queryId,parameters:plan.parameters},job.projectId,{profile:job.originProfile??job.agentProfile,senderId:job.senderId})).approvalRequired;}catch{return false;}})());
    return queries.length?[{...e,queries}]:[];
  });
}
export function continuationSpec(entries){return entries.length?[{
  tool:'continue_environment',args:{environmentId:'exact next database environmentId in continuationCatalog',queryId:'exact queryId',parameters:['brief single-line purpose with known tables, keys, filters and formulas'],repairResultRef:'optional: latest saved finalize_report REPORT_INPUT resultRef when the missing independent evidence is in another authorized database'},
  description:'当前来源已取得成果，剩余目标需要另一个已登记数据库且规则/参数已明确时，优先本工具直接接续，不要finish后让源码模型重新规划相同步骤。先保存完整数据集；程序关闭当前步骤后重新校验范围和权限，再领取下一步，不执行本工具中的数据库查询。不能用于猜口径、访问目录外系统或切换测试生产、跳过尚未解决的工具失败或声明原问题完成；唯一允许的未解决输入接续是finalize_report的已保存REPORT_INPUT：明确repairResultRef去另一已授权库补独立证据，原核验仍未通过。源码不足时finish complete=false返回源码调查。'
}]:[];}
export function validateContinuation(config,plan,job,args,projects=null){
  const entries=continuationCatalog(config,plan,job,projects),entry=entries.find(e=>e.environmentId===args?.environmentId);
  if(!entry?.queries.some(q=>q.queryId===args.queryId))throw new Error('下一步仅能选择原话题已授权且同运行环境的数据库只读模板');
  const request={environmentId:args.environmentId,queryId:args.queryId,parameters:args.parameters,goalIds:null};
  const grant=projects?planTaskRead(config,projects,job,request):planQuery(config,request,job.projectId,{profile:job.originProfile??job.agentProfile,senderId:job.senderId});
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
  if(!result?.nextEnvironmentQuery||!['partial','ready'].includes(result.outcome)||result.environmentFailure||result.exportFiles?.length||(result.toolInputErrors?.some(e=>!e.resolved)&&!validReportRepair(result,job)))return null;
  const source=[...(job.context??[])].reverse().find(x=>x.kind==='analysis_turn'&&x.result?.handoffGate?.passed===true)?.result;
  if(!source||source.sourceQuestionId!==job.questionId||!source.workspace||source.workspace!==source.sourceSync?.workspace||source.investigation?.blocker)return null;
  return {...source,outcome:'needs_clarification',environmentQuery:result.nextEnvironmentQuery,websiteQuery:null,environmentSetup:null,
    environmentContinuation:true,summary:'保留已核验源码与已保存数据，直接接续同问题已明确的数据库步骤；完整目标仍待最终审阅。'};
}

// Only a persisted, still-unresolved finalization input failure can request this
// detour. It remains a failure until the actual report is finalized successfully.
export async function reportRepairHandoff({results,pendingInputs,resultRef,plan,request,loadFailure,verifyDraft}){
 if(pendingInputs.size!==1||!pendingInputs.has('finalize_report')||typeof resultRef!=='string')throw Error('Only report finalization input repair may continue with an unresolved check');
 const failed=results.filter(r=>r.tool==='finalize_report'&&r.error),last=failed.at(-1);
 if(last?.error.code!=='REPORT_INPUT'||last.error.resultRef!==resultRef||failed.some(r=>r.error.code!=='REPORT_INPUT'||!r.error.resultRef))throw Error('Repair must reference the latest persisted REPORT_INPUT failure');
 const saved=await loadFailure(resultRef),body=JSON.parse(saved.text),args=body.arguments;
 if(saved.tool!=='finalize_report'||body.failed!==true||body.error?.code!=='REPORT_INPUT'||!/^dataset-[a-f0-9-]{36}$/.test(args?.datasetRef??''))throw Error('Invalid saved report repair');
 const draft=await verifyDraft(args.datasetRef);if(!draft?.reportDraft)throw Error('Repair requires a scoped saved report draft');
 return {version:1,tool:'finalize_report',failureRef:resultRef,failureRefs:failed.map(r=>r.error.resultRef),datasetRef:args.datasetRef,arguments:args,fromEnvironmentId:plan.environmentId,fromProjectId:plan.projectId,fromTier:plan.tier,toEnvironmentId:request.environmentId,queryId:request.queryId};
}
export function validReportRepair(result,job){
 const r=result?.repairContinuation,errors=(result?.toolInputErrors??[]).filter(e=>!e.resolved);
 return Boolean(r?.version===1&&r.tool==='finalize_report'&&r.fromProjectId===job.projectId&&r.fromEnvironmentId===result.environmentEvidence?.environmentId&&r.toEnvironmentId===result.nextEnvironmentQuery?.environmentId&&r.queryId===result.nextEnvironmentQuery?.queryId&&/^dataset-[a-f0-9-]{36}$/.test(r.datasetRef??'')&&r.arguments?.datasetRef===r.datasetRef&&Array.isArray(r.failureRefs)&&r.failureRefs.includes(r.failureRef)&&errors.length&&errors.every(e=>e.tool==='finalize_report'&&e.code==='REPORT_INPUT'&&r.failureRefs.includes(e.resultRef)));
}
