import { connectionEndpoints } from '../shared/connection-endpoints.js';
import { failureDiagnostic } from '../shared/failure-diagnostic.js';
import { presentEnvironmentResult } from './environment-result-presentation.js';
import { investigateEnvironment } from './environment-investigator.js';
import { loadEnvironments } from '../shared/environment-access.js';
import { readEnvironment } from './environment-connector.js';
import { CodexConversationEngine } from '../control-plane/codex-conversation.js';
import path from 'node:path';
import { publicText } from '../control-plane/result-presentation.js';
export async function executeEnvironmentJob(job, config, emit) {
  const response = await fetch(`${config.serverUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/environment-claim`, {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${config.runnerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ leaseId: job.lease.id, runnerId: job.lease.runnerId }) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    // Only the fixed classifier output reaches the result, never the raw HTTP body.
    throw new Error(failureDiagnostic(detail.error ?? '环境接口未成功响应'));
  }
  const { plan } = await response.json();
  await emit({ type: 'progress', phase: 'tool_activity', activity: { current: '执行已批准范围的环境只读查询', total: 1, completed: 0, recent: [] } });
  let result, environment;
  try { const cfg = await loadEnvironments(); environment = cfg.environments[plan.environmentId]; result = environment?.queries[plan.queryId]?.mode === 'investigate' ? await investigateEnvironment(plan, emit, environment.kind==='website' ? {tools:async()=>websiteTools(job,config),checkpoint:job.browserCheckpoint} : {}) : await readEnvironment(plan); }
  catch (error) {
    const diagnostic = failureDiagnostic(error);
    if (/^错误码：BROWSER_BRIDGE\b/.test(diagnostic)) return { outcome:'needs_clarification', browserLoginRequired:true,
      browserActionRequired:'automation', summary:'AgentOS 正在等待 macOS 放行后台 Chrome 自动化。业务网站登录态仍然有效，放行后会自动继续原问题，无需回复“继续”。',
      finalMessage:`${diagnostic}\n\n这不是业务账号未登录，也不会丢失原问题和已有证据。`, verification:[] };
    return { outcome: 'blocked', summary: diagnostic, finalMessage: diagnostic, verification: [] };
  }
  if(result.loginRequired) {
    const loginUrl = environment?.kind === 'website' ? environment.baseUrl : '';
    return {outcome:'needs_clarification',browserLoginRequired:true,browserCheckpoint:result.checkpoint,loginUrl,
      summary:`正在等待登录：${loginUrl || '当前业务网站'}。可在运行AgentOS的电脑上手动登录，或直接回复本任务卡“账号 / 密码”；成功后自动继续原问题。`,
      finalMessage:`当前需要登录的网站：${loginUrl || '入口尚未登记，请补充对应环境的网址'}。直接回复本任务卡即可，不要求固定格式；例如“admin / 123456”。凭据写入本机 Mac 钥匙串，不进入模型、任务结果或长期记忆。验证码、短信或扫码仍需在本机 Chrome 完成。`,verification:[]};
  }
  let explanation = '';
  const engine = new CodexConversationEngine({ dataDir: path.join(config.worktreeRoot, 'environment-summary') });
  try {
    const answer = await engine.decide({ role: 'developer', administrator: false, memory: { enabled: true }, history: [], jobs: [], attachments: [],
      message: '用业务用户能懂的中文直接回答原问题，控制在200字内，分为“已确认”“尚未确认”“下一步”。先说明是否找到原因；记录数量不是业务单据总数，字段值不是根因。超时是本次排查中断，不得当作用户报错的原因。解释关键术语，不罗列原始字段。除非原问题就是询问连接地址，否则不要把主机端口库名当作业务答案；仅发现入口而未查实际单据时明确“实际单据尚未核实”。只陈述本次确实存在的缺口，不套用无关的记录数、超时、根因提醒。不执行工具、不建立任务、不推断未知事实、不承诺已重试。',
      queryPurpose: plan.description,
      originalQuestion: String(job.instruction ?? '').slice(0, 4000),
      priorSourceEvidence: (job.context ?? []).filter(x => !x.result?.environmentEvidence).slice(-1).map(x => ({ stage: x.stage,
        summary: String(x.result?.summary ?? '').slice(0, 1000), findings: String(x.result?.finalMessage ?? '').slice(0, 6000) })),
      environmentResult: result, sourcePolicy: { historicalSnapshot: true } }, { sessionKey: `environment-result:${job.id}` });
    if (answer.action === 'reply') explanation = publicText(answer.reply);
  } catch { explanation = '自动解释暂不可用，以下为本次实际查询结果。'; }
  finally { await engine.close(); }
  const presented = presentEnvironmentResult(plan, result, explanation);
  const safeSummary = presented.metadata;
  const scopeDetails = publicText(`查询范围与授权\n环境：${plan.environmentId} (${plan.tier}) · 模板：${plan.queryId}\n参数：${JSON.stringify(plan.parameters)}\n最多 ${plan.maxRows} 条 · 超时 ${plan.timeoutMs} ms\n授权截止：${plan.expiresAt}\n仅本次只读查询，不授权修改。`);
  return { outcome: result.partial ? 'partial' : 'ready', summary: presented.summary, finalMessage: [presented.summary, explanation ? `业务解释\n${explanation}` : '', result.summary ? `排查记录\n${result.summary}` : '', result.runtimeDiscoveries?.length ? `调度入口证据（待网页核验）\n${JSON.stringify(result.runtimeDiscoveries)}` : '', presented.details, (result.steps ?? []).join(' → '), safeSummary, scopeDetails].filter(Boolean).join('\n\n'),
    websiteMismatch: result.websiteMismatch === true, runtimeDiscoveries: result.runtimeDiscoveries ?? [], connectionEndpoints: connectionEndpoints(result.rows), environmentEvidence: result.evidence, memorySafeSummary: safeSummary, verification: [] };
}

function websiteTools(job,config){
 return {spec:[{tool:'connection',args:{},description:'打开从原问题或项目源码发现的业务网页，复用本机登录会话'},
 {tool:'report_wrong_site',args:{},description:'当前页面属于其他系统或不是原问题的目标应用时报告入口不匹配，返回原问题继续查找正确入口，不扩大权限'},
 {tool:'browser_open',args:{},description:'查看当前业务网页'}, {tool:'browser_snapshot',args:{},description:'刷新页面文本和引用'},
 {tool:'browser_click',args:{ref:'当前read-action引用'},description:'查看详情、日志、菜单、翻页；不能启动停止或修改'},
 {tool:'browser_select',args:{ref:'当前select引用',value:'返回的选项value'},description:'选择查询筛选项'},
 {tool:'browser_search',args:{ref:'当前search引用',text:'查询条件'},description:'填写搜索条件，再点击查询'}],
 async run(tool,args={}){if(tool==='report_wrong_site')return {websiteMismatch:true,partial:true,stage:'当前网站与问题目标不匹配，需要重新发现正确入口；不是用户权限不足'};const response=await fetch(`${config.serverUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/website-tool`,{method:'POST',signal:AbortSignal.timeout(45000),headers:{authorization:`Bearer ${config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({leaseId:job.lease.id,runnerId:job.lease.runnerId,tool,args})});const value=await response.json();if(!response.ok)throw new Error(value.error??'网页工具执行失败');return value.result;},async close(){}};
}
