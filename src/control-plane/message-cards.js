import { stageLabel } from '../shared/protocol.js';
import { createHash } from 'node:crypto';
import { publicText, conciseSummary, resultPages, resultPanel } from './result-presentation.js';
export { publicText } from './result-presentation.js';

export function jobActionVersion(job) {
  return createHash('sha256').update((job.questionId ? `${job.id}|` : '') + (job.events ?? []).filter((e) => ['started', 'clarification_received'].includes(e.type))
    .map((e) => e.id ?? e.at).join('|')).digest('hex').slice(0, 16);
}

function actionButton(job, action, label, type = 'default') {
  const button = { tag: 'button', type, width: 'fill', text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { action, version: jobActionVersion(job) } }] };
  if (['cancel', 'approve'].includes(action)) button.confirm = {
    title: { tag: 'plain_text', content: label },
    text: { tag: 'plain_text', content: action === 'cancel' ? '停止后保留已有文件修改，不会回滚代码。确定继续？' : '确认当前阶段结论通过，并将任务交给下一角色执行？' },
  };
  return button;
}

export const CARD_TEXT_LIMIT = 3500;
const clip = (text, n) => Array.from(String(text ?? '')).slice(0, n).join('');
const md = (content, small = false) => ({ tag: 'markdown', content, text_size: small ? 'notation' : 'normal', margin: '0px' });
const block = (elements, color = 'grey') => ({ tag: 'column_set', flex_mode: 'none', columns: [
  { tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '8px',
    background_style: `${color}-50`, elements },
] });
function card(title, subtitle, color, elements) {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default', summary: { content: title } },
    header: { title: { tag: 'plain_text', content: title }, subtitle: { tag: 'plain_text', content: clip(subtitle, 100) },
      template: color, icon: { tag: 'standard_icon', token: 'ai-common_colorful' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements } };
}
export function resultSummary(text) {
  return conciseSummary(text);
}
export function resultParts(text) {
  // Escape only AFTER slicing: never cut an HTML entity, and keep overflow lossless.
  const points = Array.from(publicText(text));
  // Slice sanitized text so credentials cannot straddle the primary/overflow boundary.
  let cut = Math.min(CARD_TEXT_LIMIT, points.length);
  const start = points.slice(0, cut).join('');
  const amp = start.lastIndexOf('&');
  if (amp > start.lastIndexOf(';') && start.slice(amp).length < 10) cut -= Array.from(start.slice(amp)).length;
  return { primary: points.slice(0, cut).join(''), overflow: points.slice(cut).join('') };
}
export function conversationCard(turn, now = Date.now()) {
  const final = ['ready', 'sent'].includes(turn.status);
  const failed = turn.aiFailed || turn.actionError;
  const state = final ? (failed ? '未执行' : '已回复') : turn.status === 'queued' ? '排队中'
    : turn.connectionWillRetry ? '连接重试中' : '正在处理';
  const color = failed ? 'red' : final ? 'green' : 'blue';
  const content = final ? conciseSummary(turn.response) : turn.status === 'queued' ? '等待同一会话前面的消息处理完成。'
    : turn.connectionWillRetry ? '连接暂时异常，Codex 正在重试，尚未得到结果。' : 'Codex 正在理解你的消息，完成后会更新在这里。';
  const elements = [block([md(content)], color)];
  if (final && turn.response?.length > 360) elements.push(resultPanel(resultPages(turn.response)));
  elements.push(md(final ? '可以继续回复这条卡片；详情翻页只更新展示，不执行任务。'
    : `已等待 ${elapsed(turn.createdAt, now)} · 本卡持续更新`, true));
  return card(`${stageLabel(turn.role)} · ${state}`, 'AgentOS / Codex', color, elements);
}
export function elapsed(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000) || 0);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function jobCard(job, now = Date.now()) {
  const labels = { running: ['执行中', 'blue'], queued: ['等待执行', 'blue'], completed: ['当前阶段已完成', 'green'],
    awaiting_approval: ['待真人确认', 'orange'], awaiting_clarification: ['待补充信息', 'orange'],
    blocked: ['任务受阻 / 未通过', 'red'], failed: ['执行失败', 'red'], cancelled: ['已取消 / 已停止', 'grey'],
    cancelling: ['正在停止', 'orange'], resubmitted: ['补充已提交', 'blue'] };
  const [label, color] = job.taskIntent === 'analysis' && job.result?.outcome === 'partial' && ['completed', 'awaiting_approval'].includes(job.status)
    ? ['部分分析完成 · 有待核实', 'orange'] : labels[job.status] ?? ['等待更新', 'grey'];
  const active = ['running', 'queued', 'cancelling'].includes(job.status);
  const events = job.events ?? [];
  const start = events.filter((e) => e.type === 'started').at(-1)?.at ?? job.createdAt;
  const relevant = events.filter((e) => Date.parse(e.at) >= Date.parse(start));
  const activity = relevant.filter((e) => e.phase === 'tool_activity').at(-1)?.activity;
  const phase = relevant.filter((e) => e.type === 'progress' && e.phase).at(-1)?.phase;
  const operation = job.status === 'cancelling' ? (job.cancellationError ?? '已请求停止，等待执行器确认进程退出；已有文件修改将保留。')
    : phase === 'verification' ? '正在运行项目验证命令' : phase === 'connection_retry' ? '连接异常，Codex 正在重试'
    : job.status === 'queued' ? (job.taskIntent === 'analysis' && job.stage === 'developer' ? '开发已接单，等待 Runner 进行只读调查。' : '已接单，等待 Runner 执行。')
    : activity?.current ?? 'Codex 正在准备 / 处理任务';
  const summary = !active && job.result?.finalMessage ? resultSummary(job.result.summary || job.result.finalMessage) : '';
  const elements = [block([md(`**${active ? '当前操作' : '结论'}**`), md(active ? publicText(clip(operation, 120))
    : summary || (job.status === 'awaiting_approval' ? '请真人管理员查看阶段结论，再点击下方按钮确认进入下一阶段。'
    : job.status === 'awaiting_clarification' ? '需要补充信息，尚未通过当前阶段。'
    : job.status === 'failed' ? '执行未成功；详细错误保留在本地日志，不在群里展示凭据或原始输出。' : label))], color),
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${elapsed(start, active ? now : Date.parse(job.updatedAt))}**`), md('本阶段耗时', true)] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${Number(activity?.total) || 0} 次**`), md('实际工具调用', true)] },
    ] }];
  if (active && activity?.recent?.length) elements.push(block([md(`**最近完成 · 展示 ${activity.recent.length} / ${Number(activity.completed) || 0} 项**`),
    ...activity.recent.slice(-3).map((item) => md(`${item.failed ? '未通过' : '完成'} · ${publicText(clip(item.label, 120))}`, true))]));
  if (!active && job.result?.finalMessage) elements.push(resultPanel(resultPages(job.result.finalMessage)));
  elements[0].columns[0].elements.push(md(publicText(job.id), true));
  if (job.taskIntent === 'analysis') elements[0].columns[0].elements.push(md('只读分析 · 不修改代码', true));
  if (job.nextJobId) elements[0].columns[0].elements.push(md(`已交给项目负责人汇总 · ${publicText(job.nextJobId)}`, true));
  if (job.delegation) elements[0].columns[0].elements.push(md(`协作：${stageLabel(job.delegation.fromStage)} → ${stageLabel(job.delegation.toStage)}`, true));
  if (job.status === 'awaiting_clarification') elements.push({ tag: 'form', name: 'clarification_form', elements: [
    { tag: 'input', name: 'clarification', input_type: 'multiline_text', rows: 3, max_length: 1000, required: true,
      width: 'fill', placeholder: { tag: 'plain_text', content: '填写需要补充的范围、路径或验收要求…' } },
    { tag: 'button', name: `clarify_${jobActionVersion(job)}`, form_action_type: 'submit', type: 'primary_filled',
      width: 'fill', text: { tag: 'plain_text', content: '提交补充 · 重新执行当前阶段' } },
  ] });
  const buttons = [];
  if (job.status === 'awaiting_approval') buttons.push(actionButton(job, 'approve', '确认进入下一阶段', 'primary_filled'));
  if (['running', 'queued', 'awaiting_clarification', 'awaiting_approval'].includes(job.status)) {
    buttons.push(actionButton(job, 'cancel', job.status === 'running' ? '停止任务' : '取消任务', 'danger'));
  }
  if (['running', 'queued', 'cancelling', 'awaiting_clarification', 'awaiting_approval'].includes(job.status)) {
    buttons.push(actionButton(job, 'refresh', '刷新状态'));
  }
  if (buttons.length) elements.push({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
    columns: buttons.map((button) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) });
  const role = ({ owner_intake: '项目负责人', owner_report: '项目负责人', developer: '开发', pm: 'PM', qa: '测试', owner_audit: '审计' })[job.stage] ?? stageLabel(job.stage);
  return card(`${role} · ${label}`, `${job.taskIntent === 'analysis' ? '只读分析' : stageLabel(job.stage)} · ${publicText(clip(job.projectName, 70))}`, color, elements);
}
