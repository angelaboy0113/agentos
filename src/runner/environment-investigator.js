import {environmentPlannerInstructions} from './environment-planner-instructions.js';
import {readPlanSpec,compileReadPlan,resolveReadPlanStep} from './read-plan.js';
import {websiteFindingSummary} from '../shared/website-finding.js';
import {isModelCapacityError,capacityScope,persistModelCheckpoint}from '../shared/model-capacity-wait.js';
import {PlannerInputCursor} from './planner-input.js';
import {continuationCatalog,continuationSpec,validateContinuation,publicContinuationCatalog,reportRepairHandoff} from './environment-continuation.js';
import {readBatchSpec,expandReadBatch} from './read-batch.js';
import {ToolResultStore,persistToolInputFailure} from './tool-result-store.js';
import {sourceQueryTools,publicSourceQueryContext,SourceEvidenceInputError} from './source-query-context.js';
import { CodexAppServer } from '../shared/codex-app-server.js';
import { codexEnvironment, loadCodexRuntimeSettings, resolveCodexBinary, conversationServerArgs } from '../shared/codex-runtime.js';
import { loadEnvironments, queryTimeout, fingerprint, planQuery, verifyApprovedPlan } from '../shared/environment-access.js';
import { failureDiagnostic } from '../shared/failure-diagnostic.js';
import { credential } from './environment-connector.js';
import { createEnvironmentTools, QueryInputError } from './environment-tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const schema = { type: 'object', additionalProperties: false, required: ['tool','arguments','summary','complete'], properties: { tool: { type: 'string' }, arguments: { type: 'string' }, summary: { type: 'string' }, complete: { type: 'boolean' } } };
const TOOL_RESULT_LIMIT = 24000;
export const verifiedFileStepComplete=(tool,result)=>Boolean(result?.exportFile&&result.changed!==false&&['finalize_report','refresh_report','revise_report_file','append_report_columns'].includes(tool));

// Carry artifact locations and current validation failures beyond the recent tool window.
// No business rows, credentials, execution quotas or automatic completion decisions.
export function reportPlannerState(results){
 const datasets=new Map(),errors=new Map();let latestDraft=null;
 for(const item of results){
  if(item.error)errors.set(item.tool,{tool:item.tool,code:item.error.code,message:String(item.error.message??'').slice(0,12000)});
  else if(item.result){
   errors.delete(item.tool);const r=item.result;
   if(r.datasetRef)datasets.set(r.datasetRef,{datasetRef:r.datasetRef,columns:r.columns?.slice(0,8),columnsLimited:r.columns?.length>8,rowCount:r.rowCount,readAt:r.readAt});
   if(r.draftFile||r.reportDraft)latestDraft={datasetRef:r.datasetRef,finalization:r.finalization??r.reportDraft?.finalization};
  }
 }
 return {latestDraft,datasets:[...datasets.values()].slice(-20),unresolvedInputs:[...errors.values()],guidance:'Reuse saved datasets. Locate report_draft via list_datasets kind filter, then inspect_dataset batch preview and populationPlans. For period counts/distinct use one period_dataset with explicit periodUnit and metrics, not a model round-trip for each cell/month. Correct the stated validation input; keep independent raw checks.'};
}


// Browser pages can expose many safe read controls alongside a long rendered body.
// Keep the useful prefix and live references, tell the planner that the view was
// compacted, and continue the same investigation instead of failing the whole job.
export function fitToolResult(value, maxBytes = TOOL_RESULT_LIMIT) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value.controls) && typeof value.pageText !== 'string')) {
    throw new Error('工具结果超出大小限制，请缩小范围');
  }
  const result = structuredClone(value);
  result.pageText = String(result.pageText ?? '').slice(0, 6000);
  result.controls = Array.isArray(result.controls) ? result.controls.map(control => ({
    ...control,
    label: String(control.label ?? '').slice(0, 100),
    ...(Array.isArray(control.options) ? { options: control.options.slice(0, 40).map(option => ({
      value: String(option.value ?? '').slice(0, 200), label: String(option.label ?? '').slice(0, 100),
    })) } : {}),
  })) : [];
  result.resultLimited = true;
  result.truncated = true;
  result.note = `${String(result.note ?? '').slice(0, 500)} 页面结果过大，AgentOS 已自动压缩可见文本和控件清单；可继续搜索、查看详情或翻页。`.trim();
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.pageText.length > 1000) {
    result.pageText = result.pageText.slice(0, Math.max(1000, Math.floor(result.pageText.length * 0.75)));
  }
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.controls.length > 1) result.controls.pop();
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.fields?.length > 1) result.fields.pop();
  if(Array.isArray(value.fields)&&result.fields.length<value.fields.length)result.fieldsLimited=true;
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('工具结果超出大小限制，请缩小范围');
  return result;
}
export async function createToolPlanner({onProgress=async()=>{},kind}={}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agentos-environment-tools-'));
  const runtime = await loadCodexRuntimeSettings();
  const cursor=new PlannerInputCursor();
  const app = new CodexAppServer({ cwd, codexBin: await resolveCodexBinary(), env: await codexEnvironment(), args: conversationServerArgs() });
  try {
    await onProgress('正在启动本机Codex服务');await app.start();await onProgress('正在核对Codex登录状态'); const account = await app.readAccount({onRetry:({attempt})=>onProgress(`Codex 登录状态检查暂时超时，正在自动恢复（第${attempt}次）；尚未执行环境查询`)}); if (account.account?.type !== 'chatgpt') throw new Error('本机需要 ChatGPT 登录');
    await onProgress('正在建立查询规划会话');
    const thread = await app.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
      ...(runtime.model ? { model: runtime.model } : {}),
      developerInstructions: environmentPlannerInstructions(kind) });
    return { next: async input => JSON.parse((await app.turn({ threadId: thread.thread.id, approvalPolicy: 'never', effort: runtime.reasoningEffort ?? 'low', input: [{ type: 'text', text: JSON.stringify(cursor.next(input)) }], outputSchema: schema }, { timeoutMs: 0 })).text),
      stats:()=>({...cursor.bytes}),
      close: async () => { await app.close(); await rm(cwd, { recursive: true, force: true }); } };
  } catch (error) { await app.close(); await rm(cwd, { recursive: true, force: true }); throw error; }
}
export async function investigateEnvironment(plan, emit = async () => {}, adapters = {}) {
  const load = adapters.load ?? loadEnvironments;
  let renewal;
  const authorizePlan=async()=>{
    if(adapters.authorizeTaskScope)await adapters.authorizeTaskScope();
    if(adapters.renewPlan&&Date.parse(plan.expiresAt)-Date.now()<=60000){
      renewal??=(async()=>{const next=await adapters.renewPlan({...plan});if(next.environmentId!==plan.environmentId||next.queryId!==plan.queryId||next.configHash!==plan.configHash||next.projectId!==plan.projectId||next.approvalProfile!==plan.approvalProfile||JSON.stringify(next.parameters)!==JSON.stringify(plan.parameters))throw new Error('Renewed read scope changed');verifyApprovedPlan(await load(),next);Object.assign(plan,next);await emit({type:'progress',phase:'environment_scope_renewed',message:'原只读范围已复核续期，继续已有工作，不重跑已完成查询'});})().finally(()=>{renewal=null;});
      await renewal;
    }
    const current=await load();verifyApprovedPlan(current,plan);return current;
  };
  let nextEnvironmentQuery=null,repairContinuation=null;
  let cfg = await authorizePlan(), e = verifyApprovedPlan(cfg, plan), q = {...e.queries[plan.queryId],timeoutMs:queryTimeout(cfg,e,e.queries[plan.queryId]),exportTimeoutMs:Math.max(e.queries[plan.queryId].exportTimeoutMs??30000,queryTimeout(cfg,e,e.queries[plan.queryId]))};
  if (q.mode !== 'investigate') throw new Error('未批准工具排查范围');
  const cred = e.kind==='website' ? {} : await (adapters.credential ?? credential)(e.credentialRef);
  // A bearer provider's public username label is not an authentication secret.
  // Masking `cnb` would corrupt real build identifiers and canonical links.
  const toolSecrets=['cnb','tsf'].includes(e.kind)?[cred.password]:[cred.username,cred.password];
  const datasetScopes=[];
  if(adapters.reportJob?.projectId===e.projectId){for(const [environmentId,entry] of Object.entries(cfg.environments)){
    if(entry.projectId!==e.projectId||entry.tier!==e.tier||!['mysql','mongodb'].includes(entry.kind)||!entry.queries?.[plan.queryId])continue;
    try{const grant=planQuery(cfg,{environmentId,queryId:plan.queryId,parameters:plan.parameters},e.projectId,{profile:adapters.reportJob.originProfile??adapters.reportJob.agentProfile,senderId:adapters.reportJob.senderId});if(!grant.approvalRequired)datasetScopes.push(fingerprint(entry));}catch{}
  }}
  const allowedDatasetProjects=new Set([adapters.continuationJob?.projectId,plan.projectId].filter(Boolean));
  for(const scope of adapters.priorDatasetScopes??[]){
   const prior=Object.values(cfg.environments).find(candidate=>fingerprint(candidate)===scope);
   if(prior&&allowedDatasetProjects.has(prior.projectId)&&prior.tier===e.tier&&['mysql','mongodb'].includes(prior.kind))datasetScopes.push(scope);
  }
  datasetScopes.splice(0,datasetScopes.length,...new Set(datasetScopes));
  const resultStore=adapters.resultStore??new ToolResultStore({directory:adapters.exportDirectory,scope:fingerprint(e),authorize:async()=>{await authorizePlan();},authorizePrior:adapters.authorizePriorToolResult,secrets:toolSecrets});
  const makeTools=async()=>{const authorize=async()=>{await authorizePlan();},base=await (adapters.tools??createEnvironmentTools)(e,q,cred,{onProgress:async p=>emit({type:'progress',phase:'tool_activity',activity:{current:`完整取数：已读取 ${p.rows} 行 · ${p.pages} 页 · ${Math.round(p.elapsedMs/1000)} 秒${p.phase==='collected'?'，正在保存核验':'，继续读取'}`,total:timing.toolCalls,completed:Math.max(0,timing.toolCalls-1),recent:steps.slice(-3).map(text=>({text}))}}),datasetScopes,readTaskInput:adapters.readTaskInput,reportJob:adapters.reportJob,dataDir:adapters.dataDir,exportDirectory:adapters.exportDirectory,originalQuestion:adapters.investigationContext?.originalQuestion,authorize,reloadDataset:async(recipe,source)=>{const current=await load(),pair=Object.entries(current.environments).find(([,candidate])=>fingerprint(candidate)===source.scope&&candidate.projectId===e.projectId&&candidate.tier===e.tier&&['mysql','mongodb'].includes(candidate.kind));if(!pair||!adapters.reportJob)throw new Error('刷新来源不属于当前已授权系统/环境');const [environmentId,candidate]=pair,grant=planQuery(current,{environmentId,queryId:plan.queryId,parameters:plan.parameters},e.projectId,{profile:adapters.reportJob.originProfile??adapters.reportJob.agentProfile,senderId:adapters.reportJob.senderId});if(grant.approvalRequired)throw new Error('刷新来源需要重新授权');const sourceQ={...candidate.queries[plan.queryId],timeoutMs:queryTimeout(current,candidate,candidate.queries[plan.queryId]),exportTimeoutMs:Math.max(candidate.queries[plan.queryId].exportTimeoutMs??30000,queryTimeout(current,candidate,candidate.queries[plan.queryId]))},reader=await createEnvironmentTools(candidate,sourceQ,await (adapters.credential??credential)(candidate.credentialRef),{datasetScopes,exportDirectory:adapters.exportDirectory,reportJob:adapters.reportJob,authorize:async()=>{await authorizePlan();const c=await load(),fresh=planQuery(c,{environmentId,queryId:plan.queryId,parameters:plan.parameters},e.projectId,{profile:adapters.reportJob.originProfile??adapters.reportJob.agentProfile,senderId:adapters.reportJob.senderId});if(fresh.approvalRequired||fresh.configHash!==fingerprint(candidate))throw new Error('Refresh source scope changed');verifyApprovedPlan(c,fresh);}});try{return await reader.run(recipe.tool==='mongo_dataset'?'group_dataset':recipe.tool,recipe.args);}finally{await reader.close();}}});
    const source=sourceQueryTools(adapters.sourceQueryContext,{authorize,secrets:toolSecrets});return {...base,spec:[...base.spec,...source.spec,{tool:'list_tool_results',args:{offset:'0 or nextOffset',limit:'1..20'},description:'定位本任务已授权来源保存的完整结果（含短末页；provenance标注来源；无需回交摘要或重查）及失败finalize_report/enrich_dataset完整参数；修复先读取resultRef，不盲重查来源。Does not query a database.'},{tool:'read_tool_result',args:{resultRef:'tool-result reference from a stored response',offset:'0 or nextOffset',limit:'1..4000 characters'},description:'Read persisted full tool JSON, including short webpage pages across phases. No query replay or arbitrary file path; continue nextOffset.'}],run:async(tool,args)=>{try{return await (tool==='list_tool_results'?resultStore.list(args):tool==='read_tool_result'?resultStore.read(args):source.spec.some(s=>s.tool===tool)?source.run(tool,args):base.run(tool,args));}catch(error){if(error instanceof SourceEvidenceInputError||error.code==='REPORT_INPUT')throw new QueryInputError(error.code,error.message);throw error;}}};};
  if(adapters.capacityCheckpoint){const descriptor=adapters.capacityCheckpoint;if(descriptor.environmentId!==plan.environmentId||descriptor.queryId!==plan.queryId||descriptor.configHash!==plan.configHash||descriptor.scopeIdentity!==capacityScope(plan))throw Error('Model checkpoint scope mismatch');const saved=await resultStore.load(descriptor.resultRef);const restored=JSON.parse(saved.text);if(restored.version!==1||restored.stage!=='environment'||!Array.isArray(restored.results)||!Array.isArray(restored.steps))throw Error('Model checkpoint version invalid');adapters={...adapters,checkpoint:restored};}
  const savedToolResults=await resultStore.list();
  let tools=await makeTools();
  const pendingBatch=[],readPlanResults=new Map();
  const timing={plannerSetupMs:0,plannerMs:0,toolMs:0,plannerCalls:0,toolCalls:0};
  let planner; const steps = [...(adapters.checkpoint?.steps??[])], results = [...(adapters.checkpoint?.results??[])]; let summary = '', complete = false, unresolvedInput = Boolean(adapters.checkpoint?.pendingInputs?.length), stalled = 0, stopReason = '';
  let websiteLogin=results.findLast(x=>x.result?.loginRequired)?.result??null;
  const awaitWebsiteLogin=()=>({loginRequired:true,summary:websiteLogin?.message??websiteLogin?.stage,checkpoint:{steps,results,lastAuthorizedAt,pendingInputs:[...pendingInputs]},rows:[],partial:true});
  let lastAuthorizedAt = adapters.checkpoint?.lastAuthorizedAt ?? null;
  const authenticationRefusals=new Set();
  const seen = new Set(),pendingInputs=new Set(adapters.checkpoint?.pendingInputs??[]);
  const carriedRepair=adapters.investigationContext?.repairContinuation;
  if(carriedRepair&&!adapters.checkpoint){results.push({tool:'finalize_report',error:{code:'REPORT_INPUT',message:'原报表核验仍待修复，补齐独立证据后重新finalize_report；不能把接续当已完成',resultRef:carriedRepair.failureRef},executed:false});pendingInputs.add('finalize_report');unresolvedInput=true;}
  let timeoutStreak = 0, unresolvedTimeout = false;
  try {
    const setupStarted=Date.now();
    try{planner = await (adapters.planner ?? createToolPlanner)({kind:e.kind,onProgress:current=>emit({type:'progress',phase:'tool_activity',activity:{current,total:0,completed:0,recent:[]}})});}
    catch(error){if(!isModelCapacityError(error))throw error;if(adapters.capacityCheckpoint)return{modelCapacityWaiting:true,modelCheckpoint:adapters.capacityCheckpoint};const saved=await persistModelCheckpoint(resultStore,{version:1,stage:'environment',results,steps,lastAuthorizedAt,pendingInputs:[...pendingInputs],notice:'规划服务创建失败前未执行本轮业务工具；原证据保留。'});return{modelCapacityWaiting:true,modelCheckpoint:{stage:'environment',resultRef:saved.resultRef,environmentId:plan.environmentId,queryId:plan.queryId,configHash:plan.configHash,scopeIdentity:capacityScope(plan)}};}
    timing.plannerSetupMs=Date.now()-setupStarted;
    const nextPlan=async input=>{const began=Date.now();timing.plannerCalls++;try{return await planner.next(input);}finally{timing.plannerMs+=Date.now()-began;}};
    let diagnosticStage = 'planning',failure=null,lastArgumentKeys=[];
    try {
    for (let i = 0; ; i++) {
      diagnosticStage = 'planning';
      // Recheck scope/expiry before every tool, not just at job claim.
      try { cfg = await authorizePlan(); e = verifyApprovedPlan(cfg, plan); }
      catch(error) { if (!results.length) throw error; stopReason = failureDiagnostic(error); break; }
      const continuationJob=adapters.continuationJob??adapters.reportJob, integrationProjects=await adapters.loadIntegrationProjects?.(), continuations=continuationCatalog(cfg,plan,continuationJob,integrationProjects);
      let choice = pendingBatch.length?pendingBatch.shift():i === 0 ? { tool: 'connection', arguments: '{}' } : i===1&&tools.spec.some(x=>x.tool==='list_datasets')?{tool:'list_datasets',arguments:'{}'}:await nextPlan({ purpose: plan.parameters[0], currentScope:{environmentId:plan.environmentId,projectId:plan.projectId,tier:plan.tier,queryId:plan.queryId,configHash:plan.configHash}, investigationContext:adapters.investigationContext, sourceQueryContext:publicSourceQueryContext(adapters.sourceQueryContext,toolSecrets), continuationCatalog:publicContinuationCatalog(continuations), websiteAuthentication:websiteLogin?{required:true,publicEvidenceOnly:true,instruction:'登录尚未成功；只可browser_assets读取原入口公开脚本与静态依赖。不能读取业务页面、声称登录/列表通过或把脚本猜成数据库事实。公开证据够本阶段取证则finish交回原问题；确实需要登录态内容时wait_for_website_login，复用原凭据自动恢复。'}:null, tools: [...tools.spec,...(websiteLogin?[{tool:'wait_for_website_login',args:{},description:'保留原问题/已有公开证据并等待本机保存凭据自动恢复，不能伪造登录成功。'}]:[]),...readPlanSpec(tools.spec),...readBatchSpec(tools.spec),...continuationSpec(continuations)], results: results.slice(-12), reportState: reportPlannerState(results),savedToolResults, progress: { toolCount: results.length, consecutiveNoProgress: stalled }, checkpointNotice:adapters.checkpoint?.notice,instruction: '已确定的团队口径直接沿用，不能因为换提问人而重问；完整源码规则一次交接，read_source_evidence支持字面search定位，不逐页遍历大文件；已有完整数据的主对象或期间范围更窄时先核对范围，再显式声明outside=exclude及真实依据，不因范围错误反复重查，独立查询可batch_read减少逐步模型往返；已明确依赖的取数、整理、关联及文件核验优先execute_read_plan，一次给出完整步骤并通过$result引用前一步真实结果，不能猜返回引用。原要求的指标与最终表格完成后直接finish，不因其中一份文件核验成功反复回源码；需要下一已授权库则continue_environment。已知表结构可一次批量schema，不把同一指标拆成每户/每月一轮规划；不将依赖前一步结果的操作提前猜测。已有完整金额文本使用summarize_dataset精确sum；独立金额分组加COUNT可用weighted_sum明确column及weightColumn精确加权，不为工具缺算术而展开重复明细。窗口基准可用带实际对象键的独立原始聚合；无对象键总计不能替代逐对象核验。核验错误带source/column/reference时只定位该列与其配方，不整套重查或切换无关环境。优先修正investigationContext.corrections中的未解决校验原因；inspect_dataset会返回草稿所需检查项。不因为REPORT_INPUT重查整套数据。list_datasets有nextOffset时继续分页找已有成果。优先用一次聚合或重复组合查询关闭核心缺口；表结构定向读取并按真实证据推进。先前结果仍在本会话历史中。' });
      if(choice.tool==='execute_read_plan'){
        try{pendingBatch.push(...compileReadPlan(choice,tools.spec));pendingInputs.delete('execute_read_plan');unresolvedInput=pendingInputs.size>0;choice=pendingBatch.shift();}
        catch{pendingBatch.length=0;pendingInputs.add('execute_read_plan');unresolvedInput=true;results.push({tool:'execute_read_plan',error:{code:'TOOL_ARGUMENTS',message:'计划未执行。steps须使用唯一id、当前工具及参数；$result仅引用本计划前面步骤的真实结果路径。请修正计划，不重跑已经取得的数据。'},executed:false});continue;}
      }
      if(choice.readPlanStep){try{choice=resolveReadPlanStep(choice,readPlanResults);}catch(error){pendingBatch.length=0;results.push({tool:choice.tool,readPlanStep:choice.readPlanStep,error:{code:'TOOL_ARGUMENTS',message:error.message},executed:false});pendingInputs.add(choice.tool);unresolvedInput=true;continue;}}
      if(choice.tool==='batch_read'){
        try{pendingBatch.push(...expandReadBatch(choice,tools.spec));choice=pendingBatch.shift();}
        catch{results.push({tool:'batch_read',error:{code:'TOOL_ARGUMENTS',message:'批次须为1至32项本环境已开放的独立只读工具和完整参数对象；请修正，不重跑已完成步骤。'},executed:false});continue;}
      }
      if(choice.tool==='wait_for_website_login'&&websiteLogin)return awaitWebsiteLogin();
      if(websiteLogin&&!(i===0&&choice.tool==='connection')&&!['browser_assets','list_tool_results','read_tool_result','read_source_evidence','finish'].includes(choice.tool)){
        const refused=JSON.stringify([choice.tool,choice.arguments]);if(authenticationRefusals.has(refused))return awaitWebsiteLogin();authenticationRefusals.add(refused);pendingBatch.length=0;
        results.push({tool:choice.tool,error:{code:'WEBSITE_AUTH_REQUIRED',message:'该业务页面操作需要认证，本次未执行。原入口公开部署脚本仍可browser_assets读取；可用已取得公开证据finish交回原问题审阅。只有实际需要登录态数据/页面才wait_for_website_login，不把一次工具选择错误当整个调查受阻。'},executed:false});continue;
      }
      if (choice.tool === 'finish') {
        const mysqlEvidence = results.some(item => item.result && ['collections','tables','schema','select','count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','relate_dataset','extend_dimension','inspect_report','inspect_dataset','read_source_evidence','compare_datasets'].includes(item.tool));
        const mysqlQueryTools = ['mysql','mongodb'].includes(e.kind) && tools.spec.some(item => ['collections','tables','schema','select','count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','relate_dataset','extend_dimension','inspect_report','inspect_dataset','read_source_evidence','compare_datasets'].includes(item.tool));
        if (mysqlQueryTools && !mysqlEvidence && !results.some(item=>item.error&&item.tool!=='finish')) {
          results.push({ tool: 'finish', error: { code: 'PREMATURE_FINISH', message: '数据库查询工具已提供；仅完成连接检查不能判断记录或声称查询工具不可用。请使用结构、明细或受控汇总工具取得与原问题相关的证据。' }, executed: false });
          steps.push('finish：仅完成连接检查，继续执行已提供的只读查询工具');
          stalled++;
          continue;
        }
        summary = String(choice.summary ?? '').slice(0, 6000); complete = choice.complete === true; break;
      }
      let args;try{if(typeof choice.arguments!=='string')throw new Error();args=JSON.parse(choice.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw new Error();}catch{results.push({tool:choice.tool,error:{code:'TOOL_ARGUMENTS',message:'工具参数须为JSON对象；修正本步骤，不重跑已完成的查询。'},executed:false});pendingInputs.add(choice.tool);unresolvedInput=true;continue;}
      if(choice.tool==='continue_environment'){
        try{
          const observedWebsite=e.kind==='website'&&results.some(x=>x.tool.startsWith('browser_')&&x.result&&!x.result.inputAttachment&&!x.result.nativeDocument&&typeof x.result.url==='string'&&x.result.pageStatus!=='login'&&x.result.authenticationVerified!==false);
          if(unresolvedTimeout||!observedWebsite&&!results.some(x=>x.result?.datasetRef||x.result?.rows?.length||x.result?.inputAttachment?.source?.kind==='authorized-native-cloud-sheet'&&x.result.complete===true&&x.result.inputAttachment.source.projectId===plan.projectId&&x.result.inputAttachment.source.originProfile===adapters.reportJob?.originProfile&&x.result.inputAttachment.source.tier===plan.tier&&/^[a-f0-9]{64}$/.test(x.result.inputAttachment.source.sha256??'')))throw new Error('先修正未解决错误并保留当前有效证据；网页没有返回业务行不妨碍选择已授权数据库，但不能用切换入口跳过数据核验失败');
          const request=validateContinuation(await authorizePlan(),plan,continuationJob,args,await adapters.loadIntegrationProjects?.());
          if(unresolvedInput)repairContinuation=await reportRepairHandoff({results,pendingInputs,resultRef:args.repairResultRef,plan,request,loadFailure:async ref=>{await authorizePlan();return resultStore.load(ref);},verifyDraft:ref=>tools.run('inspect_dataset',{datasetRef:ref,limit:1,sections:['reportDraft']})});
          nextEnvironmentQuery=request;
          summary=String(choice.summary??'').trim().slice(0,6000)||'已保存本步骤证据，申请同问题下一数据库步骤；完整原问题仍待审阅。';complete=false;break;
        }catch(error){results.push({tool:choice.tool,error:{code:'CONTINUATION_INPUT',message:error.message},executed:false});continue;}
      }
      lastArgumentKeys=args&&typeof args==='object'?Object.keys(args).filter(k=>['datasetRef','ref','startLine','leftRef','rightRef','leftKey','rightKey','table','columns','filters','sourceColumn','targetColumn','lookups','keyColumn','groupColumns','aggregates'].includes(k)).slice(0,12):[];
      if (!tools.spec.some(x => x.tool === choice.tool)) throw new Error('未开放该环境工具');
      try { await authorizePlan(); }
      catch(error) { if (!results.length) throw error; stopReason = failureDiagnostic(error); break; }
      lastAuthorizedAt = new Date().toISOString();
      await emit({ type: 'progress', phase: 'tool_activity', activity: { current: `只读工具：${choice.tool}`, total: i + 1, completed: i, recent: steps.slice(-3).map(text => ({ text })) } });
      diagnosticStage = choice.tool;
      let result;

      try { const began=Date.now();timing.toolCalls++;try{result = await tools.run(choice.tool, args);}finally{timing.toolMs+=Date.now()-began;} }
      catch (error) {
        pendingBatch.length=0;
        if (['mysql','mongodb'].includes(e.kind) && ['schema','tables','database_clock','collections','select', 'count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','relate_dataset','extend_dimension','inspect_report','inspect_dataset','read_source_evidence','compare_datasets'].includes(choice.tool) && /^错误码：TIMEOUT\b/m.test(failureDiagnostic(error))) {
          unresolvedTimeout = true;
          results.push({ tool: choice.tool, error: { code: 'TIMEOUT', message: '本次查询超时，连接已关闭；不是业务故障根因。重新读取目标表结构，缩小时间范围、增加单号等条件或选择其他证据路径。保持原授权和单次等待上限。' }, completed: false });
          steps.push('select：查询超时，保留已有证据，正在调整查询');
          await tools.close({ abort: true });
          timeoutStreak++;
          await authorizePlan();
          tools=await makeTools();
          await emit({ type: 'progress', phase: 'tool_activity', activity: { current: '查询超时，正在调整条件继续排查', total: i + 1, completed: i, recent: [] } });
          continue;
        }
        // Fixed local query/browser input errors can be corrected. Scope/auth failures still stop.
        if (!(error instanceof QueryInputError) || !['read_config_values','schema','tables','database_clock','collections','select', 'count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','relate_dataset','extend_dimension','inspect_report','inspect_dataset','list_datasets','read_source_evidence','compare_datasets','browser_click','browser_search','browser_select','browser_snapshot','browser_inspect','browser_assets','browser_navigate','browser_recover','browser_frames','browser_frame','browser_read','browser_open','browser_screenshot','browser_key','browser_scroll','report_wrong_site','applications','current_version','current_inventory','instances','deployment_history','log_configurations','search_logs','container_log_tail','data_sources','groups','tasks','task_detail','task_batches','build_repositories','build_history','pull_requests','pull_request','pull_request_index'].includes(choice.tool)) throw error;
        pendingInputs.add(choice.tool);unresolvedInput = true;
        results.push(await persistToolInputFailure(resultStore,choice.tool,args,error));
        steps.push(`${choice.tool}：${error.code}，本步骤未完成，已有成果保留`);
        if(error.code==='DATASET_CAPACITY'){stopReason=failureDiagnostic(error);break;}
        stalled++;
        continue;
      }
      if (['read_config_values','schema','tables','database_clock','collections','select', 'count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','relate_dataset','extend_dimension','inspect_report','inspect_dataset','list_datasets','read_source_evidence','compare_datasets','browser_click','browser_search','browser_select','browser_snapshot','browser_inspect','browser_assets','browser_navigate','browser_recover','browser_frames','browser_frame','browser_read','browser_open','browser_screenshot','browser_key','browser_scroll','report_wrong_site','applications','current_version','current_inventory','instances','deployment_history','log_configurations','search_logs','container_log_tail','data_sources','groups','tasks','task_detail','task_batches','build_repositories','build_history','pull_requests','pull_request','pull_request_index'].includes(choice.tool)) { pendingInputs.delete(choice.tool);unresolvedInput=pendingInputs.size>0;if(['select','count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset'].includes(choice.tool)){unresolvedTimeout=false;timeoutStreak=0;} }
      if(choice.tool==='browser_snapshot'){for(const name of [...pendingInputs])if(name.startsWith('browser_'))pendingInputs.delete(name);unresolvedInput=pendingInputs.size>0;}
      if(choice.tool==='connection'&&!result.loginRequired)websiteLogin=null;
      if(result.loginRequired){
        websiteLogin=result;
        if(e.kind!=='website'||!tools.spec.some(x=>x.tool==='browser_assets'))return awaitWebsiteLogin();
        // Only list public script refs at the approved entry; no authentication or business query replay.
        await authorizePlan();let catalog;try{const began=Date.now();timing.toolCalls++;try{catalog=await tools.run('browser_assets',{});}finally{timing.toolMs+=Date.now()-began;}}catch{return awaitWebsiteLogin();}
        if(!catalog?.assets?.length)return awaitWebsiteLogin();
        results.push({tool:choice.tool,result:{...result,publicEvidenceOnly:true}},{tool:'browser_assets',result:catalog});steps.push('登录态业务页面尚未读取；已获取原入口公开脚本目录');continue;
      }
      result = await resultStore.present(choice.tool,result,TOOL_RESULT_LIMIT,{persist:e.kind==='website'&&['browser_read','browser_snapshot'].includes(choice.tool)||e.kind==='tsf'&&['groups','current_version','instances','deployment_history','log_configurations','search_logs','container_log_tail','current_inventory'].includes(choice.tool)||e.kind==='cnb'&&['build_history','pull_requests','pull_request','pull_request_index'].includes(choice.tool)||e.kind==='tct'&&['tasks','task_detail','task_batches','groups'].includes(choice.tool)});
      results.push({ tool: choice.tool, result,...(choice.readPlanStep?{readPlanStep:choice.readPlanStep}:{}) }); steps.push(`${choice.tool}：${result.stage ?? '已执行'}`);
      if(choice.readPlanStep)readPlanResults.set(choice.readPlanStep,structuredClone(result));
      if(verifiedFileStepComplete(choice.tool,result)){pendingInputs.clear();unresolvedInput=false;if(!adapters.continuationJob?.continuousInvestigation&&!pendingBatch.length){summary='当前文件已通过程序核验，返回源码Agent按原问题审阅；不在工具层追加历史对账。';complete=true;break;}steps.push('此文件核验完成；继续同一会话处理原要求的剩余指标，不新增旁支交付条件');}
      if(result.websiteFinding||result.websiteMismatch){summary=websiteFindingSummary(result);complete=false;break;}
      const hash = fingerprint({tool:choice.tool,result:result.resultStored&&result.sha256?{savedContentSha256:result.sha256}:result});
      stalled = seen.has(hash) ? stalled + 1 : 0; seen.add(hash);

    }
    } catch (error) {
      if(diagnosticStage==='planning'&&isModelCapacityError(error)){
       if(adapters.capacityCheckpoint&&results.slice(adapters.checkpoint.results.length).every(x=>['connection','list_datasets'].includes(x.tool)&&x.result))return{modelCapacityWaiting:true,modelCheckpoint:adapters.capacityCheckpoint};
       const checkpoint={version:1,stage:'environment',results,steps,lastAuthorizedAt,pendingInputs:[...pendingInputs],notice:'已有结果为之前取证，重建只读连接不代表同一事务。旧临时setRef不沿用，优先从保存数据重建，不重跑已完成业务查询。'};
       const saved=await persistModelCheckpoint(resultStore,checkpoint);
       return {modelCapacityWaiting:true,modelCheckpoint:{stage:'environment',resultRef:saved.resultRef,environmentId:plan.environmentId,queryId:plan.queryId,configHash:plan.configHash,scopeIdentity:capacityScope(plan)}};
      }
      const caughtFailure = Object.assign(new Error(String(error?.message ?? error)), {
        code:error?.code,platformCode:error?.platformCode,apiAction:error?.apiAction,rpcMethod:error?.rpcMethod,diagnosticStage: error?.diagnosticStage ?? error?.rpcMethod ?? diagnosticStage
      });
      if (!results.some(x => x.result)) throw caughtFailure;
      stopReason = failureDiagnostic(caughtFailure);failure={code:/^错误码：(\w+)/.exec(stopReason)?.[1]??'EXECUTION_ERROR',tool:diagnosticStage,diagnostic:stopReason,errorName:['Error','TypeError','RangeError','QueryInputError','ReportInputError','SourceEvidenceInputError'].includes(error.name)?error.name:'Error',argumentKeys:lastArgumentKeys,sourceLocation:String(error.stack??'').match(/src\/(?:runner|shared)\/[a-z0-9-]+\.js:\d+:\d+/i)?.[0]??null};
      steps.push(stopReason);
      // Do not retry a failed operation or expand scope. Summarize only prior evidence.
    }
    if (!summary) {
      // Final synthesis uses existing evidence only; it cannot execute another query.
      try {
        const final = await nextPlan({ purpose: plan.parameters[0], currentScope:{environmentId:plan.environmentId,projectId:plan.projectId,tier:plan.tier,queryId:plan.queryId,configHash:plan.configHash}, investigationContext:adapters.investigationContext, sourceQueryContext:publicSourceQueryContext(adapters.sourceQueryContext,toolSecrets), tools: [], results: results.slice(-20), remainingCalls: 0, stopReason,
          completionPolicy: '没有固定调用次数上限；remainingCalls=0仅表示本次进入只汇总阶段，不表示调用额度耗尽。仅依据stopReason解释暂停原因。',
          instruction: '排查已暂停。仅返回finish汇总已有证据、来源表与未查明原因，不执行工具、不把查到记录等同根因已确认。' });
        if (final.tool === 'finish') { summary = String(final.summary ?? '').slice(0,6000); complete = final.complete === true; }
      } catch { /* Preserve gathered evidence if summary generation fails. */ }
    }
    if(websiteLogin&&!stopReason&&!results.some(x=>x.tool==='browser_assets'&&x.result?.text?.trim()))return awaitWebsiteLogin();
    if(websiteLogin)complete=false; // Public evidence returns to source review; it never certifies authenticated business access.
    if (!summary) summary = '本次排查未完成；以下为已取得的证据。';
    // A planner cannot turn unresolved extraction or an empty evidence trail into success.
    if (nextEnvironmentQuery || stopReason || results.filter(x => x.result).length < 2 || unresolvedInput || unresolvedTimeout || results.some((x,index) => x.result?.partial&&!(e.kind==='website'&&x.result.pageStatus==='loading'&&results.slice(index+1).some(later=>later.result?.pageStatus==='ready'&&typeof x.result.url==='string'&&later.result.url===x.result.url)))) complete = false;
    if (unresolvedInput) summary = '仍有工具参数尚未修正；已取得的结果继续保留，完整交付尚未通过核验。';
    if (stopReason) summary = `${stopReason}\n\n${summary}`;
    if(adapters.renewPlan&&!stopReason)await authorizePlan();
    const serialized = JSON.stringify(results);
    for (const secret of toolSecrets.filter(Boolean)) summary = summary.split(secret).join('[已隐藏]');
    const uniqueResults = [...new Map(results.filter(x => x.result).map(x => [fingerprint(x), x])).values()];
  const business=uniqueResults.filter(x=>['select','count','group_count','aggregate','linked_aggregate','group_dataset','linked_group_dataset','window_dataset','period_dataset','transform_dataset','collect_dataset_values','summarize_dataset','explain_query','indexes','deployment_evidence','read_dataset','read_tool_result','list_tool_results','compose_report','finalize_report','refresh_report','enrich_dataset','compare_datasets','read_cloud_sheet','read_cloud_document','restore_cloud_sheet_input','import_task_input','append_report_columns','revise_report_file'].includes(x.tool)).map(x=>({tool:x.tool,inputContentHash:x.result.inputAttachment?.source?.sha256??x.result.registeredPage?.id,inputRange:x.result.inputAttachment?.source?.range??x.result.registeredPage?.range,table:x.result.table,rows:Array.isArray(x.result.rows)?x.result.rows.map(row=>JSON.stringify(row)).sort():undefined,dataHash:x.result.dataHash??x.result.exportFile?.sha256,columns:x.result.columns,totals:x.result.totals}));
    if(e.kind==='cnb')business.push(...uniqueResults.filter(x=>['build_history','pull_requests','pull_request','pull_request_index'].includes(x.tool)).map(x=>({tool:x.tool,repository:x.result.repository,rows:x.result.rows,resultHash:x.result.resultHash})));
    if(e.kind==='tsf')business.push(...uniqueResults.filter(x=>['groups','current_version','instances','deployment_history','log_configurations','search_logs','container_log_tail','current_inventory'].includes(x.tool)).map(x=>({tool:x.tool,applicationId:x.result.applicationId,rows:x.result.rows,current:x.result.current,group:x.result.group,range:x.result.range})));
    if(e.kind==='tct')business.push(...uniqueResults.filter(x=>['groups','tasks','task_detail','task_batches'].includes(x.tool)).map(x=>({tool:x.tool,rows:x.result.rows,task:x.result.task})));
    if(e.kind==='website')business.push(...uniqueResults.filter(x=>x.result?.url&&typeof x.result.pageText==='string').map(x=>({url:x.result.url,pageText:x.result.pageText,fields:x.result.fields??[]})));
    if(e.kind==='website')business.push(...uniqueResults.filter(x=>['browser_read','browser_inspect','browser_assets'].includes(x.tool)&&x.result?.url).map(x=>({url:x.result.url,section:x.result.section,offset:x.result.offset,text:x.result.text,...(x.tool==='browser_assets'?{dataHash:x.result.contentHash,imports:x.result.imports?.map(i=>i.url)}:{}),...(x.tool==='browser_inspect'?{label:x.result.label,chain:x.result.chain,scopeFields:x.result.scopeFields}:{})})));
    return { nextEnvironmentQuery,repairContinuation,reportRepairResolution:carriedRepair&&uniqueResults.some(x=>x.tool==='finalize_report'&&x.result?.exportFile)?{failureRef:carriedRepair.failureRef,verifiedFileId:uniqueResults.find(x=>x.tool==='finalize_report'&&x.result?.exportFile).result.exportFile.id,verificationHash:uniqueResults.find(x=>x.tool==='finalize_report'&&x.result?.exportFile).result.exportFile.verificationHash}:null,schemaEvidence:uniqueResults.filter(x=>x.tool==='schema').map(x=>Object.fromEntries(['tables','columnMetadata','metadataOnly','searchApplied','truncated','nextCursor','resultStored','resultRef','omittedFields'].filter(k=>x.result[k]!==undefined).map(k=>[k,x.result[k]]))),toolResultCatalog:[...(adapters.priorToolResultCatalog??[]).map(x=>({...x,inherited:true})),...uniqueResults.filter(x=>x.result?.resultStored).map(x=>({provenance:{environmentId:plan.environmentId,queryId:plan.queryId,projectId:plan.projectId,tier:plan.tier,scope:plan.configHash},resultRef:x.result.resultRef,tool:x.tool,bytes:x.result.bytes,...(x.result.applicationId?{applicationId:x.result.applicationId}:{}),...(x.result.groupId?{groupId:x.result.groupId}:{})}))],fileInspections:uniqueResults.filter(x=>x.tool==='inspect_report').map(x=>x.result).slice(-1),failure,toolInputErrors:results.filter(x=>x.error&&typeof x.executed==='boolean').map(x=>({tool:x.tool,executed:x.executed,code:x.error.code,...(x.error.resultRef?{resultRef:x.error.resultRef}:{}),message:toolSecrets.filter(Boolean).reduce((m,secret)=>m.split(secret).join('[已隐藏]'),String(x.error.message??'')).slice(0,1200),resolved:!pendingInputs.has(x.tool)})).slice(-12),datasetCatalog:uniqueResults.flatMap(x=>x.result?.datasets??[]), websiteScreenshots:[...new Map(uniqueResults.flatMap(x=>[...(x.result?.screenshot?[x.result.screenshot]:[]),...(x.result?.screenshotDeliveries??[])]).map(item=>[item.sha256,item])).values()], exportFiles: uniqueResults.flatMap(x=>x.result?.exportFile?[x.result.exportFile]:[]), websiteMismatch: results.some(x => x.result?.websiteMismatch === true),websiteFinding:uniqueResults.findLast(x=>x.result?.websiteFinding)?.result.websiteFinding??null, runtimeDiscoveries: uniqueResults.filter(x => x.result?.runtimeDiscovery).map(x => x.result.runtimeDiscovery), rows: uniqueResults.filter(x => x.result?.rows).flatMap(x => x.result.rows.map(row => x.result.table ? { ...row, '来源表': x.result.table } : row)), steps, summary, partial: !complete,
      note: e.kind === 'tsf' ? 'TSF fixed container deployment metadata reads only; no deployment, rollback, environment variables, YAML or business writes. Change time and pod creation time are not exact rollout completion time.' : e.kind === 'cnb' ? (e.cnb.resources?.includes('pull-requests')?'仅本次精确仓库合并请求固定GET；未创建或合并请求、触发构建、部署或读取原始正文。关闭时间不是独立合并时间；目录需与固定分支祖先关联。':'仅本次精确仓库的CNB构建历史固定GET；未触发构建、部署或读取原始日志。构建成功不等于所有服务当前运行版本已核验。') : e.kind === 'tct' ? '本次仅使用已登记调度分组的固定只读接口，未触发、停止或修改任务；账号本身的只读权限未验证。' : e.kind === 'website' ? (websiteLogin?'本次仅读取原入口公开部署脚本，未验证登录或业务页面，未执行修改。':'本次读取业务网页，未执行修改。') : e.kind === 'nacos' ? 'Nacos 读取与数据库连接是两步；本次未连接数据库。' : '仅本次范围内的数据库只读工具。',
      evidence: {...(websiteLogin?{authenticationVerified:false,publicAssetsOnly:true}:{}),plannerPayload:planner?.stats?.()??null, completeDatasetCount:uniqueResults.filter(x=>x.result?.datasetRef&&x.result.complete===true).length,savedDatasetReadCount:uniqueResults.filter(x=>['inspect_dataset','read_dataset','window_dataset','period_dataset','transform_dataset','summarize_dataset','enrich_dataset','collect_dataset_values'].includes(x.tool)).length,timing,environmentId: plan.environmentId, queryId: plan.queryId, configHash:plan.configHash, scopeHash: plan.scopeHash, readAt: new Date().toISOString(), lastAuthorizedAt, toolCount: results.length, businessProgressHash:business.length?fingerprint([...new Set(business.map(x=>JSON.stringify(x)))].sort()):null, businessQueryCount:['mysql','mongodb'].includes(e.kind)?uniqueResults.reduce((n,x)=>n+(x.tool==='refresh_report'?(x.result.refresh?.sourceCount??0):!x.result.reused&&['select','count','group_count','aggregate','collect_values','linked_aggregate','group_dataset','linked_group_dataset'].includes(x.tool)?1:0),0):undefined, rowCount: uniqueResults.reduce((n,x)=>n+(x.tool==='refresh_report'?(x.result.exportFile?.rowCount??0):x.result?.datasetRef?x.result.rowCount:Array.isArray(x.result?.rows)?x.result.rows.length:0),0), resultHash: fingerprint(serialized) } };
  } finally { try { await tools.close(); } finally { await planner?.close(); } }
}
