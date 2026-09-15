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
  try { const cfg = await loadEnvironments(); result = cfg.environments[plan.environmentId]?.queries[plan.queryId]?.mode === 'investigate' ? await investigateEnvironment(plan, emit) : await readEnvironment(plan); }
  catch (error) { return { outcome: 'blocked', summary: error.message, finalMessage: error.message, verification: [] }; }
  const safeSummary = `${result.partial ? '部分结果，排查尚未完成。' : ''}${plan.tier.toUpperCase()} · ${plan.description}：已查询 ${result.rows.length} 条${result.truncated ? '（结果受限，非全部数据）' : ''}。读取时间：${result.evidence.readAt}。${result.note ?? ''}`;
  let explanation = '';
  const engine = new CodexConversationEngine({ dataDir: path.join(config.worktreeRoot, 'environment-summary') });
  try {
    const answer = await engine.decide({ role: 'developer', administrator: false, memory: { enabled: true }, history: [], jobs: [], attachments: [],
      message: '只解释这次受控查询的脱敏结果与缺口，不执行工具、不建立任务、不推断未知事实。',
      queryPurpose: plan.description,
      originalQuestion: String(job.instruction ?? '').slice(0, 4000),
      priorSourceEvidence: (job.context ?? []).filter(x => !x.result?.environmentEvidence).slice(-1).map(x => ({ stage: x.stage,
        summary: String(x.result?.summary ?? '').slice(0, 1000), findings: String(x.result?.finalMessage ?? '').slice(0, 6000) })),
      environmentResult: result, sourcePolicy: { historicalSnapshot: true } }, { sessionKey: `environment-result:${job.id}` });
    if (answer.action === 'reply') explanation = publicText(answer.reply);
  } catch { explanation = '自动解释暂不可用，以下为本次实际查询结果。'; }
  finally { await engine.close(); }
  const rows = result.rows.map((row, i) => `记录 ${i + 1}\n${Object.entries(row).map(([k, v]) => `${k}：${publicText(String(v))}`).join('\n')}`).join('\n\n');
  return { outcome: result.partial ? 'partial' : 'ready', summary: safeSummary, finalMessage: [safeSummary, (result.steps ?? []).join(' → '), result.summary, explanation, rows].filter(Boolean).join('\n\n'),
    environmentEvidence: result.evidence, memorySafeSummary: safeSummary, verification: [] };
}
