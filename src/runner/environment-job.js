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
  if (!response.ok) throw new Error('查询授权、有效期或执行租约未通过；未访问环境');
  const { plan } = await response.json();
  await emit({ type: 'progress', phase: 'tool_activity', activity: { current: '执行已批准范围的环境只读查询', total: 1, completed: 0, recent: [] } });
  let result;
  try { const cfg = await loadEnvironments(); result = cfg.environments[plan.environmentId]?.queries[plan.queryId]?.mode === 'investigate' ? await investigateEnvironment(plan, emit, cfg.environments[plan.environmentId].kind==='website' ? {tools:async()=>websiteTools(job,config),checkpoint:job.browserCheckpoint} : {}) : await readEnvironment(plan); }
  catch (error) { return { outcome: 'blocked', summary: failureDiagnostic(error), finalMessage: failureDiagnostic(error), verification: [] }; }
  if(result.loginRequired) return {outcome:'needs_clarification',browserLoginRequired:true,browserCheckpoint:result.checkpoint,summary:'正在等待本机登录。已在运行AgentOS的电脑上打开网页，登录成功后自动继续原问题，无需回复继续。',finalMessage:'登录会话由本机独立浏览器保存；会话失效才需要再次登录。等待期间其他任务可以继续。',verification:[]};
  let explanation = '';
  const engine = new CodexConversationEngine({ dataDir: path.join(config.worktreeRoot, 'environment-summary') });
  try {
    const answer = await engine.decide({ role: 'developer', administrator: false, memory: { enabled: true }, history: [], jobs: [], attachments: [],
      message: '用业务用户能懂的中文直接回答原问题，控制在200字内，分为“已确认”“尚未确认”“下一步”。先说明是否找到原因；记录数量不是业务单据总数，字段值不是根因。超时是本次排查中断，不得当作用户报错的原因。解释关键术语，不罗列原始字段。不执行工具、不建立任务、不推断未知事实、不承诺已重试。',
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
    runtimeDiscoveries: result.runtimeDiscoveries ?? [], connectionEndpoints: connectionEndpoints(result.rows), environmentEvidence: result.evidence, memorySafeSummary: safeSummary, verification: [] };
}

function websiteTools(job,config){
 return {spec:[{tool:'connection',args:{},description:'打开从原问题或项目源码发现的业务网页，复用本机登录会话'},
 {tool:'browser_open',args:{},description:'查看当前业务网页'}, {tool:'browser_snapshot',args:{},description:'刷新页面文本和引用'},
 {tool:'browser_click',args:{ref:'当前read-action引用'},description:'查看详情、日志、菜单、翻页；不能启动停止或修改'},
 {tool:'browser_select',args:{ref:'当前select引用',value:'返回的选项value'},description:'选择查询筛选项'},
 {tool:'browser_search',args:{ref:'当前search引用',text:'查询条件'},description:'填写搜索条件，再点击查询'}],
 async run(tool,args={}){const response=await fetch(`${config.serverUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/website-tool`,{method:'POST',signal:AbortSignal.timeout(45000),headers:{authorization:`Bearer ${config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({leaseId:job.lease.id,runnerId:job.lease.runnerId,tool,args})});const value=await response.json();if(!response.ok)throw new Error(value.error??'网页工具执行失败');return value.result;},async close(){}};
}
