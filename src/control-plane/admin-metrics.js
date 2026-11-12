const DAY = 86_400_000;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const MARKER = /^\s*[【\[]\s*(?:AgentOS\s*)?维护自测[^】\]]*[】\]]/i;
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
const inWindow = (at, now) => Number.isFinite(at) && at > now - DAY && at <= now;

export function maintenanceTest(item, question) {
  return item?.isMaintenanceTest === true || question?.isMaintenanceTest === true
    || MARKER.test(item?.originalQuestion ?? item?.content ?? question?.title ?? '');
}

export function taskDisplayStatus(job) {
  if (job.status !== 'completed') return job.status ?? 'unknown';
  return ({ready:'completed', partial:'partial', blocked:'blocked', failed:'failed',
    needs_clarification:'awaiting_clarification', needs_approval:'awaiting_approval'})[job.result?.outcome] ?? 'unverified';
}

function terminalTime(job) {
  const event = (job.events ?? []).findLast(e => e.type === job.status && Number.isFinite(date(e.at)));
  return date(event?.at ?? job.completedAt ?? job.updatedAt);
}

export function taskWallMs(job, question) {
  if (!['completed','blocked','failed','cancelled'].includes(job.status)) return null;
  const value = terminalTime(job) - date(question?.createdAt ?? job.createdAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// A question card may have several workflow jobs or recoveries. Only its latest
// job represents its current result; ordinary intake replies are never results.
export function adminTaskMetrics(state, now = Date.now(), {includeMaintenance = false} = {}) {
  const latest = new Map();
  for (const job of state.jobs ?? []) {
    if (!Number.isFinite(date(job.createdAt)) || date(job.createdAt) > now) continue;
    const q = state.questions?.[job.questionId];
    const key = JSON.stringify([job.originProfile ?? q?.profile ?? '', job.chatId ?? q?.chatId ?? '', job.questionId ?? job.id]);
    const prior = latest.get(key);
    if (!prior || date(job.createdAt) > date(prior.createdAt)
      || date(job.createdAt) === date(prior.createdAt) && String(job.id) > String(prior.id)) latest.set(key, job);
  }
  const counts = {active:0, completed24h:0, partial24h:0, failed24h:0, blocked24h:0,
    cancelled24h:0, unverified24h:0, waiting:0, finished24h:0, total:latest.size,
    maintenance24h:0, replies24h:0, intake24h:0};
  const durations = [];
  for (const job of latest.values()) {
    const q = state.questions?.[job.questionId], test = maintenanceTest(job, q);
    const end = terminalTime(job), ended = inWindow(end, now), status = taskDisplayStatus(job);
    if (test && (inWindow(date(job.createdAt), now) || ended)) counts.maintenance24h++;
    // Active tasks include maintenance because they occupy real runner slots.
    if (ACTIVE.has(job.status)) counts.active++;
    if (test && !includeMaintenance) continue;
    if (['awaiting_clarification', 'awaiting_approval'].includes(status)) { counts.waiting++; continue; }
    if (!['completed', 'failed', 'blocked', 'cancelled'].includes(job.status) || !ended) continue;
    if (job.status === 'cancelled') { counts.cancelled24h++; continue; }
    counts.finished24h++;
    const field = ({completed:'completed24h', partial:'partial24h', failed:'failed24h',
      blocked:'blocked24h', unverified:'unverified24h'})[status];
    counts[field ?? 'unverified24h']++;
    // The question-to-terminal wall time includes queue/waits/recoveries. The
    // last model turn's timing.totalMs must not stand in for the whole question.
    const duration = taskWallMs(job, q);
    if (duration !== null) durations.push(duration);
  }
  const turns = new Map();
  for (const turn of state.conversations ?? []) {
    if (turn.status !== 'sent' || !inWindow(date(turn.completedAt ?? turn.aiCompletedAt), now)
      || !includeMaintenance && maintenanceTest(turn, state.questions?.[turn.questionId])) continue;
    const key = JSON.stringify([turn.profile ?? '', turn.chatId ?? '', turn.messageId ?? turn.id]);
    const prior = turns.get(key);
    if (!prior || date(turn.createdAt) > date(prior.createdAt)) turns.set(key, turn);
  }
  for (const turn of turns.values()) counts[turn.decision?.action === 'create_task' ? 'intake24h' : 'replies24h']++;
  durations.sort((a,b) => a-b);
  const percentile = p => durations.length ? durations[Math.ceil(durations.length*p)-1] : null;
  const middle = Math.floor(durations.length/2);
  const median = !durations.length ? null : durations.length%2 ? durations[middle] : (durations[middle-1]+durations[middle])/2;
  return {counts, performance:{medianMs:median, p95Ms:percentile(.95), sampleCount:durations.length,
    successRate:counts.finished24h ? Math.round(counts.completed24h/counts.finished24h*1000)/10 : null},
    metricPolicy:{version:'question-card-results-v1', from:new Date(now-DAY).toISOString(), to:new Date(now).toISOString(),
      includeMaintenance, timeBasis:'terminal_event', unit:'latest_job_per_profile_chat_question',
      successDefinition:'completed_ready_only', rateDenominator:'ready_partial_blocked_failed_unverified',
      durationBasis:'original_question_to_terminal_including_waits', cancellationsExcluded:true,
      coverage:'retained_state_only'}};
}
