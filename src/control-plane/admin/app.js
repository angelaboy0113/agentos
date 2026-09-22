const state = { overview: null, settings: null, records: [] };
const titles = { overview: '运行概览', records: '任务记录', settings: '模型设置' };
const statusMap = {
  queued: ['排队中', 'warn'], running: ['执行中', 'live'], cancelling: ['停止中', 'warn'],
  completed: ['已完成', 'good'], sent: ['已回复', 'good'], failed: ['失败', 'bad'],
  blocked: ['受阻', 'bad'], cancelled: ['已取消', 'bad'], awaiting_approval: ['待确认', 'warn'],
  awaiting_clarification: ['待补充', 'warn'], decided: ['待发送', 'live'], pending: ['处理中', 'live'],
};
const stageMap = { owner_intake: '项目负责人', pm: '产品经理', developer: '开发', qa: '测试', owner_audit: '审计', owner_report: '负责人汇总' };
const effortMap = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超强' };
const modelLabels = { 'gpt-6-astra': 'GPT-6 Astra', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna', 'gpt-5.5': 'GPT-5.5' };

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.goto)));
document.querySelector('#refresh').addEventListener('click', refreshCurrent);
document.querySelector('#runtime-form').addEventListener('submit', saveRuntime);
document.querySelector('#close-drawer').addEventListener('click', closeDrawer);
document.querySelector('#drawer-backdrop').addEventListener('click', closeDrawer);
for (const id of ['record-kind', 'record-status']) document.querySelector(`#${id}`).addEventListener('change', loadRecords);
let searchTimer;
document.querySelector('#record-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadRecords, 220); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
  if (/^[123]$/.test(event.key) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) showView(['overview', 'records', 'settings'][Number(event.key) - 1]);
});

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

async function loadOverview() {
  try {
    const { overview } = await api('/api/v1/admin/overview'); state.overview = overview;
    document.querySelector('#service-dot').classList.add('online');
    document.querySelector('#service-label').textContent = 'AgentOS 正常';
    const runtime = overview.runtime;
    document.querySelector('#hero-model').textContent = modelName(runtime.model);
    document.querySelector('#hero-effort').textContent = runtime.reasoningEffort ? `推理强度：${effortMap[runtime.reasoningEffort] ?? runtime.reasoningEffort}` : '推理强度继承本机 Codex 设置';
    setText('metric-active', overview.counts.active);
    setText('metric-completed', overview.counts.completed24h);
    setText('metric-success', overview.performance.successRate === null ? '—' : `${overview.performance.successRate}%`);
    setText('metric-median', duration(overview.performance.medianMs));
    setText('runner-state', overview.runnerPool?.total ? `${overview.runnerPool.online}/${overview.runnerPool.total} 在线 · ${overview.runnerPool.busy} 忙碌` : '尚未注册');
    setText('health-model', modelName(runtime.model)); setText('health-failed', overview.counts.failed24h);
    document.querySelector('#recent-list').innerHTML = overview.recent.length ? overview.recent.map(recordRow).join('') : '<div class="loading-row">暂无处理记录</div>';
    bindRecordButtons(document.querySelector('#recent-list'));
    document.querySelector('#audit-list').innerHTML = overview.audit.length ? overview.audit.map((item) => `<p>${escapeHtml(dateTime(item.at))} · 模型设置已更新</p>`).join('') : '<p>暂无变更</p>';
    markUpdated();
  } catch (error) { offline(error); }
}

async function loadRecords() {
  const params = new URLSearchParams({ kind: value('record-kind'), status: value('record-status'), q: value('record-search'), limit: '200' });
  try {
    const body = await api(`/api/v1/admin/records?${params}`); state.records = body.records;
    document.querySelector('#records-body').innerHTML = body.records.length ? body.records.map(recordTableRow).join('') : '<tr><td colspan="5" class="empty">没有符合条件的记录</td></tr>';
    bindRecordButtons(document.querySelector('#records-body')); markUpdated();
  } catch (error) { toast(error.message); }
}

async function loadSettings() {
  try {
    const body = await api('/api/v1/admin/settings/runtime'); state.settings = body;
    const options = [{ id: '', label: '继承本机 Codex', description: '沿用当前账号的默认模型', inherit: true }, ...body.models];
    document.querySelector('#model-options').innerHTML = options.map((model) => `<label class="model-choice${model.inherit ? ' inherit' : ''}"><input type="radio" name="model" value="${escapeHtml(model.id)}" ${model.id === (body.runtime.model ?? '') ? 'checked' : ''}><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.description)}</small></label>`).join('');
    const efforts = [{ id: '', label: '继承本机设置' }, ...body.efforts.map((id) => ({ id, label: effortMap[id] ?? id }))];
    document.querySelector('#reasoning-effort').innerHTML = efforts.map((item) => `<option value="${item.id}" ${item.id === (body.runtime.reasoningEffort ?? '') ? 'selected' : ''}>${item.label}</option>`).join('');
    markUpdated();
  } catch (error) { toast(error.message); }
}

async function saveRuntime(event) {
  event.preventDefault();
  const button = event.submitter; button.disabled = true; button.textContent = '正在保存';
  try {
    const model = new FormData(event.currentTarget).get('model') || null;
    const reasoningEffort = value('reasoning-effort') || null;
    const body = await api('/api/v1/admin/settings/runtime', { method: 'PUT', headers: { 'x-agentos-admin': '1' }, body: JSON.stringify({ model, reasoningEffort }) });
    document.querySelector('#save-message').textContent = body.message;
    toast('模型设置已保存'); await loadOverview();
  } catch (error) { document.querySelector('#save-message').textContent = ''; toast(error.message); }
  finally { button.disabled = false; button.textContent = '保存模型设置'; }
}

async function openRecord(id) {
  try {
    const { record } = await api(`/api/v1/admin/records/${encodeURIComponent(id)}`);
    document.querySelector('#detail-title').textContent = record.title;
    document.querySelector('#detail-body').innerHTML = detailMarkup(record);
    document.querySelector('#drawer-backdrop').hidden = false;
    document.querySelector('#record-drawer').classList.add('open');
    document.querySelector('#record-drawer').setAttribute('aria-hidden', 'false');
  } catch (error) { toast(error.message); }
}

function closeDrawer() { document.querySelector('#record-drawer').classList.remove('open'); document.querySelector('#record-drawer').setAttribute('aria-hidden', 'true'); document.querySelector('#drawer-backdrop').hidden = true; }
function showView(name) { document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${name}`)); document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === name)); setText('page-title', titles[name]); if (name === 'records') loadRecords(); if (name === 'settings') loadSettings(); }
function refreshCurrent() { const current = document.querySelector('.nav-item.active')?.dataset.view; if (current === 'records') loadRecords(); else if (current === 'settings') loadSettings(); else loadOverview(); }
function bindRecordButtons(root) { root.querySelectorAll('[data-record]').forEach((item) => item.addEventListener('click', () => openRecord(item.dataset.record))); }

function recordRow(item) { const status = statusInfo(item.status); return `<button class="record-row" data-record="${escapeHtml(item.id)}"><span class="record-icon">${item.kind === 'job' ? '任' : '答'}</span><span class="record-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.projectName)} · ${escapeHtml(stageMap[item.stage] ?? item.stage ?? '普通回复')}</small></span><span class="record-meta"><span class="pill ${status[1]}">${status[0]}</span><small>${dateTime(item.createdAt)}</small></span></button>`; }
function recordTableRow(item) { const status = statusInfo(item.status); return `<tr data-record="${escapeHtml(item.id)}"><td class="task-cell"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.projectName)}</small></td><td><span class="pill ${status[1]}">${status[0]}</span></td><td>${escapeHtml(modelName(item.model))}</td><td>${duration(item.durationMs)}</td><td>${dateTime(item.createdAt)}</td></tr>`; }
function detailMarkup(item) {
  const status = statusInfo(item.status);
  const events = item.events?.length ? `<div class="timeline">${item.events.map((event) => `<div class="timeline-item"><strong>${escapeHtml(eventLabel(event))}</strong><small>${dateTime(event.at)}${event.message ? ` · ${escapeHtml(event.message)}` : ''}</small></div>`).join('')}</div>` : '<p>这条记录没有分阶段事件。</p>';
  return `<div class="detail-grid"><div class="detail-stat"><small>状态</small><strong><span class="pill ${status[1]}">${status[0]}</span></strong></div><div class="detail-stat"><small>模型</small><strong>${escapeHtml(modelName(item.model))}</strong></div><div class="detail-stat"><small>总耗时</small><strong>${duration(item.durationMs)}</strong></div><div class="detail-stat"><small>推理强度</small><strong>${escapeHtml(effortMap[item.reasoningEffort] ?? item.reasoningEffort ?? '未记录')}</strong></div><div class="detail-stat"><small>工具调用</small><strong>${item.toolCount ?? 0} 次</strong></div><div class="detail-stat"><small>处理角色</small><strong>${escapeHtml(stageMap[item.stage] ?? item.stage ?? '普通回复')}</strong></div></div>${section('用户问题', item.originalQuestion ?? item.content ?? item.title)}${section('AgentOS 回复', item.result?.finalMessage ?? item.response ?? '暂无回复')}${item.result?.summary && item.result.summary !== item.result.finalMessage ? section('结论摘要', item.result.summary) : ''}<section class="detail-section"><h3>处理时间线</h3>${events}</section>`;
}
function section(title, content) { return `<section class="detail-section"><h3>${title}</h3><p>${escapeHtml(content)}</p></section>`; }
function eventLabel(event) { if (event.phase === 'tool_activity') return event.activity?.current ?? '调用工具'; return ({ started: '开始执行', progress: '处理进展', completed: '执行完成', failed: '执行失败', cancelled: '任务取消' })[event.type] ?? event.type; }
function statusInfo(status) { return statusMap[status] ?? [status || '未知', '']; }
function modelName(id) { return state.settings?.models?.find((item) => item.id === id)?.label ?? modelLabels[id] ?? id ?? '继承本机设置'; }
function duration(ms) { if (!Number.isFinite(ms)) return '—'; if (ms < 1000) return `${ms} 毫秒`; const seconds = Math.round(ms / 1000); if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); return `${minutes} 分 ${seconds % 60} 秒`; }
function dateTime(value) { if (!value) return '—'; return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function value(id) { return document.querySelector(`#${id}`).value.trim(); }
function setText(id, text) { document.querySelector(`#${id}`).textContent = text; }
function markUpdated() { setText('updated-at', `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`); }
function offline(error) { document.querySelector('#service-dot').classList.remove('online'); setText('service-label', '连接失败'); toast(error.message); }
function toast(message) { const box = document.querySelector('#toast'); box.textContent = message; box.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, 3200); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

loadOverview();
