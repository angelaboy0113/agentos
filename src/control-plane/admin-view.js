const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export function adminOverview(state, runtime, now = Date.now()) {
  const records = adminRecords(state);
  const recent = records.filter((item) => now - Date.parse(item.createdAt) <= 24 * 60 * 60 * 1000);
  const finished = recent.filter((item) => TERMINAL.has(item.status) || item.status === 'sent');
  const durations = finished.map((item) => item.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const successful = finished.filter((item) => ['completed', 'sent'].includes(item.status));
  const runners = Object.values(state.runners ?? {}).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const runner = runners[0] ?? null;
  return {
    runtime,
    counts: {
      active: records.filter((item) => ['queued', 'running', 'cancelling'].includes(item.status)).length,
      completed24h: successful.length,
      failed24h: finished.length - successful.length,
      total: records.length,
    },
    performance: {
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      successRate: finished.length ? Math.round(successful.length / finished.length * 1000) / 10 : null,
    },
    runner: runner ? { ...runner, online: now - Date.parse(runner.lastSeenAt) < 30_000 } : null,
    recent: records.slice(0, 8),
    audit: (state.adminAudit ?? []).slice(-8).reverse(),
  };
}

export function adminRecords(state, query = {}) {
  const jobs = (state.jobs ?? []).map(jobRecord);
  const conversations = (state.conversations ?? []).map(conversationRecord);
  let records = [...jobs, ...conversations].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (query.kind && query.kind !== 'all') records = records.filter((item) => item.kind === query.kind);
  if (query.status && query.status !== 'all') records = records.filter((item) => item.status === query.status);
  if (query.search) {
    const needle = query.search.toLocaleLowerCase('zh-CN');
    records = records.filter((item) => [item.id, item.title, item.projectName, item.stage, item.response]
      .some((value) => String(value ?? '').toLocaleLowerCase('zh-CN').includes(needle)));
  }
  return records.slice(0, Math.min(Math.max(Number(query.limit) || 100, 1), 500));
}

export function adminRecordDetail(state, id) {
  const job = (state.jobs ?? []).find((item) => item.id === id);
  if (job) return { ...jobRecord(job), instruction: job.instruction, originalQuestion: job.originalQuestion,
    result: publicResult(job.result), events: (job.events ?? []).map(publicEvent), createdAt: job.createdAt, updatedAt: job.updatedAt };
  const turn = (state.conversations ?? []).find((item) => item.id === id);
  if (turn) return { ...conversationRecord(turn), content: turn.content, decision: publicDecision(turn.decision),
    timing: turn.timing ?? null, response: turn.response ?? '', createdAt: turn.createdAt, updatedAt: turn.completedAt ?? turn.aiCompletedAt ?? turn.createdAt };
  return null;
}

function jobRecord(job) {
  const durationMs = job.result?.timing?.totalMs ?? elapsed(job.createdAt, job.updatedAt, job.status);
  const activity = (job.events ?? []).filter((event) => event.type === 'progress' && event.activity).at(-1)?.activity;
  const toolCount = job.result?.environmentEvidence?.toolCount ?? (Number(activity?.total) || 0);
  return {
    id: job.id, kind: 'job', title: clip(job.originalQuestion ?? job.instruction ?? job.id, 180),
    projectId: job.projectId ?? null, projectName: job.projectName ?? job.projectId ?? '未归属项目',
    stage: job.stage ?? null, status: job.status ?? 'unknown', createdAt: job.createdAt, updatedAt: job.updatedAt,
    durationMs, model: job.result?.model ?? null, reasoningEffort: job.result?.reasoningEffort ?? null,
    toolCount, response: clip(job.result?.finalMessage ?? job.result?.summary ?? '', 1200), outcome: job.result?.outcome ?? null,
  };
}

function conversationRecord(turn) {
  return {
    id: turn.id, kind: 'conversation', title: clip(turn.content ?? turn.id, 180),
    projectId: turn.projectId ?? null, projectName: turn.projectId ?? '普通对话', stage: turn.role ?? null,
    status: turn.status ?? 'unknown', createdAt: turn.createdAt, updatedAt: turn.completedAt ?? turn.aiCompletedAt ?? turn.createdAt,
    durationMs: turn.timing?.totalMs ?? elapsed(turn.createdAt, turn.completedAt ?? turn.aiCompletedAt, turn.status),
    model: turn.timing?.model ?? null, reasoningEffort: turn.timing?.reasoningEffort ?? null,
    toolCount: 0, response: clip(turn.response ?? turn.decision?.reply ?? '', 1200), outcome: turn.outcome ?? null,
  };
}

function publicResult(result) {
  if (!result) return null;
  const allowed = ['outcome', 'summary', 'finalMessage', 'model', 'reasoningEffort', 'timing',
    'sourceSyncBlocked', 'browserLoginRequired'];
  return Object.fromEntries(allowed.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}

function publicDecision(decision) {
  if (!decision) return null;
  return Object.fromEntries(['action', 'intent', 'reply', 'reason'].filter((key) => decision[key] !== undefined).map((key) => [key, decision[key]]));
}

function publicEvent(event) {
  return Object.fromEntries(['id', 'type', 'at', 'phase', 'message', 'activity'].filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
}

function elapsed(start, end, status) {
  if (!start || !end || (!TERMINAL.has(status) && status !== 'sent')) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function clip(value, length) {
  const text = String(value ?? '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
