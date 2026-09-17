import { loadEnvironments, verifyApprovedPlan } from './environment-access.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId, nextStage } from './protocol.js';

const emptyState = () => ({ version: 1, jobs: [], runners: {}, processedMessages: {} });

export class JsonStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.queue = Promise.resolve();
  }

  transact(operation) {
    const run = this.queue.then(async () => {
      const state = await this.read();
      const result = await operation(state);
      await this.write(state);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  transactEffect(key, operation) {
    return this.transact((state) => {
      state.effects ??= {};
      if (key && state.effects[key]) return state.effects[key];
      const result = operation(state);
      if (key) state.effects[key] = structuredClone(result);
      return result;
    });
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async write(state) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  async createJob(input) {
    return this.transact((state) => {
      if (input.sourceMessageId && state.processedMessages[input.sourceMessageId]) {
        const existing = state.jobs.find((job) => job.id === state.processedMessages[input.sourceMessageId]);
        return { job: existing, duplicate: true };
      }
      const now = new Date().toISOString();
      const job = {
        id: createId('JOB'),
        ...(input.questionId ? { questionId: input.questionId } : {}),
        ...(input.connectionEnrollmentPending ? {connectionEnrollmentPending:true} : {}),
        ...(input.environmentAccess ? { environmentAccess: structuredClone(input.environmentAccess) } : {}),
        missionId: input.missionId ?? createId('MISSION'),
        projectId: input.projectId,
        projectName: input.projectName ?? input.projectId,
        chatId: input.chatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        replyToMessageId: input.replyToMessageId ?? input.sourceMessageId ?? null,
        originMessageId: input.originMessageId ?? input.replyToMessageId ?? input.sourceMessageId ?? null,
        senderId: input.senderId ?? null,
        agentRole: input.agentRole ?? input.stage ?? null,
        agentProfile: input.agentProfile ?? null,
        requestedAgentRole: input.requestedAgentRole ?? input.agentRole ?? input.stage ?? null,
        requestedAgentProfile: input.requestedAgentProfile ?? input.agentProfile ?? null,
        delegation: input.delegation ?? null,
        workflow: input.workflow,
        stage: input.stage,
        instruction: input.instruction,
        originalQuestion: input.originalQuestion ?? input.instruction,
        taskIntent: input.taskIntent ?? 'implementation',
        ...(input.sourceEnvironment ? { sourceEnvironment: input.sourceEnvironment } : {}),
        originProfile: input.originProfile ?? input.requestedAgentProfile ?? input.agentProfile ?? null,
        originChatType: input.originChatType ?? null,
        context: input.context ?? [],
        attachmentRefs: input.attachmentRefs ?? [],
        attachments: input.attachments ?? [],
        status: input.status ?? 'queued',
        lease: null,
        events: [],
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      state.jobs.push(job);
      if (input.sourceMessageId) state.processedMessages[input.sourceMessageId] = job.id;
      return { job, duplicate: false };
    });
  }

  async approveEnvironment(id, approver, scopeHash, effectKey, guard = () => {}) {
    return this.transactEffect(effectKey, (state) => {
      const job = requireJob(state, id); guard(state, job);
      if (job.status !== 'awaiting_environment_approval' || job.environmentAccess?.scopeHash !== scopeHash
        || Date.parse(job.environmentAccess.expiresAt) <= Date.now()) throw new Error('查询申请已过期或状态改变，请重新申请');
      job.environmentAccess.approvedBy = approver; job.environmentAccess.approvedAt = new Date().toISOString();
      job.status = 'queued'; job.updatedAt = new Date().toISOString();
      job.events.push({ id: createId('EVT'), type: 'environment_approved', at: job.updatedAt, scopeHash });
      return structuredClone(job);
    });
  }

  async claimEnvironment(id, identity) {
    const config = await loadEnvironments();
    return this.transact((state) => {
      const job = requireJob(state, id);
      if (job.status !== 'running' || job.lease?.id !== identity.leaseId || job.lease?.runnerId !== identity.runnerId || !(Date.parse(job.lease?.expiresAt) > Date.now())) throw new Error('查询租约已失效');
      verifyApprovedPlan(config, job.environmentAccess ?? {});
      if (!job.environmentAccess.approvedBy || job.environmentAccess.startedAt) throw new Error('查询未批准或已经执行；不自动重试');
      job.environmentAccess.startedAt = new Date().toISOString();
      job.events.push({ id: createId('EVT'), type: 'environment_query_started', at: job.environmentAccess.startedAt, scopeHash: job.environmentAccess.scopeHash });
      return structuredClone(job.environmentAccess);
    });
  }

  async getJob(id) {
    const state = await this.read();
    return state.jobs.find((job) => job.id === id) ?? null;
  }

  async reconcileLegacyResults() {
    return this.transact((state) => {
      let corrected = 0;
      for (const job of state.jobs) {
        if (job.status === 'awaiting_approval' && needsClarification(job, job.result)) {
          job.status = 'awaiting_clarification';
          job.updatedAt = new Date().toISOString();
          job.events.push({ type: 'status_reconciled', at: job.updatedAt, message: '旧结果明确待澄清，不应放行。' });
          corrected++;
        }
      }
      return corrected;
    });
  }

  async addAttachment(jobId, attachment) {
    return this.transact((state) => {
      const job = requireJob(state, jobId);
      job.attachments.push(attachment);
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async activateDraft(parentMessageId, input) {
    return this.transact((state) => {
      const draftId = state.processedMessages[parentMessageId];
      const job = state.jobs.find((candidate) => candidate.id === draftId);
      if (!job || job.status !== 'awaiting_instruction') return null;
      job.sourceInstructionMessageId = input.sourceMessageId;
      job.replyToMessageId = input.replyToMessageId ?? input.sourceMessageId;
      job.instruction = input.instruction;
      job.workflow = input.workflow;
      job.stage = input.stage;
      job.agentRole = input.agentRole ?? input.stage;
      job.agentProfile = input.agentProfile ?? job.agentProfile ?? null;
      job.requestedAgentRole = input.requestedAgentRole ?? job.requestedAgentRole ?? input.agentRole ?? input.stage;
      job.requestedAgentProfile = input.requestedAgentProfile ?? job.requestedAgentProfile ?? input.agentProfile ?? null;
      job.delegation = input.delegation ?? null;
      job.status = 'queued';
      job.updatedAt = new Date().toISOString();
      if (input.sourceMessageId) state.processedMessages[input.sourceMessageId] = job.id;
      return structuredClone(job);
    });
  }

  async heartbeat(runner) {
    return this.transact((state) => {
      state.runners[runner.runnerId] = { ...runner, lastSeenAt: new Date().toISOString() };
      return state.runners[runner.runnerId];
    });
  }

  async leaseNext(runnerId, capabilities = [], leaseSeconds = 120) {
    return this.transact((state) => {
      const now = Date.now();
      for (const job of state.jobs) {
        if (job.status === 'running' && job.lease && Date.parse(job.lease.expiresAt) <= now) {
          // An expired lease is not evidence that its process has exited.
          job.status = 'cancelling';
          job.cancelReason = '执行器租约过期，等待原执行器确认退出；不自动重复执行。';
        }
      }
      const job = state.jobs.find((candidate) => candidate.status === 'queued' &&
        !state.jobs.some((other) => other.status === 'cancelling' && other.projectId === candidate.projectId) &&
        (capabilities.length === 0 || capabilities.includes(candidate.stage)));
      if (!job) return null;
      job.status = 'running';
      job.lease = {
        id: createId('LEASE'),
        runnerId,
        leasedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + leaseSeconds * 1000).toISOString(),
      };
      job.updatedAt = new Date().toISOString();
      return structuredClone(job);
    });
  }

  async appendEvent(jobId, event, completionRouting = {}) {
    return this.transact((state) => {
      const job = requireJob(state, jobId);
      if (event.leaseId && (job.lease?.id !== event.leaseId || job.lease?.runnerId !== event.runnerId)) {
        throw new Error('Stale or foreign Runner lease');
      }
      if (['cancelled', 'completed', 'failed', 'blocked', 'awaiting_approval', 'awaiting_clarification', 'awaiting_environment_approval'].includes(job.status)) {
        throw new Error('Task is already terminal');
      }
      const entry = { id: createId('EVT'), at: new Date().toISOString(), ...event };
      job.events.push(entry);
      if (event.type === 'heartbeat' && job.lease) {
        job.lease.expiresAt = new Date(Date.now() + 120_000).toISOString();
      }
      if (event.type === 'cancelled') {
        if (job.status !== 'cancelling' || !event.leaseId || !event.processesExited) throw new Error('Cancellation requires process-exit acknowledgement');
        job.status = 'cancelled';
        job.lease = null;
      }
      if (event.type === 'completed' && job.status !== 'cancelling') {
        if (event.result?.outcome === 'partial' && job.environmentAccess) {
          const p = job.environmentAccess, e = event.result.environmentEvidence;
          if (job.taskIntent !== 'analysis' || !p.approvedBy || !p.startedAt
            || !job.events.some(x => x.type === 'environment_query_started' && x.scopeHash === p.scopeHash)
            || !e || e.environmentId !== p.environmentId || e.queryId !== p.queryId || e.scopeHash !== p.scopeHash
            || !Number.isFinite(Date.parse(e.readAt)) || Date.parse(e.readAt) < Date.parse(p.startedAt)
            || !Number.isInteger(e.rowCount) || e.rowCount < 0 || !/^[a-f0-9]{64}$/.test(e.resultHash ?? '')
            || !event.result.finalMessage) throw new Error('Invalid partial environment evidence');
        }
        if (event.result?.outcome === 'partial' && !job.environmentAccess && (job.taskIntent !== 'analysis'
          || event.result.sourceSyncBlocked || event.result.handoffGate?.passed !== true
          || !event.result.verifiedArtifacts?.length || !event.result.handoff?.risks?.length
          || !event.result.sourceSync?.repositories?.length)) throw new Error('Invalid partial analysis evidence');
        job.result = event.result ?? null;
        job.status = event.result?.outcome === 'blocked' ? 'blocked' : needsClarification(job, event.result)
          ? 'awaiting_clarification'
          : nextStage(job.workflow, job.stage) ? 'awaiting_approval' : 'completed';
        job.lease = null;
      }
      if (event.type === 'failed' && job.status !== 'cancelling') {
        job.result = event.result ?? { error: event.message ?? 'Runner failed' };
        job.status = 'failed';
        job.lease = null;
      }
      if (event.type === 'failed' && job.status === 'cancelling') job.cancellationError = '执行器无法确认停止，已暂停领取新任务，请管理员检查本机进程。';
      job.updatedAt = new Date().toISOString();
      let nextJob = null;
      if (event.type === 'completed' && job.status === 'awaiting_clarification'
        && job.taskIntent === 'analysis' && ['developer', 'owner_report'].includes(job.stage) && job.questionId && !job.environmentAccess
        && event.result?.environmentQuery && completionRouting.environmentPlan && completionRouting.agentProfile) {
        nextJob = makeNextJob(job, 'developer', completionRouting, job.updatedAt);
        Object.assign(nextJob, { workflow: 'single_developer', status: 'awaiting_environment_approval',
          environmentAccess: completionRouting.environmentPlan,
          delegation: { fromStage: 'developer', toStage: 'developer', reason: '源码排查需要环境证据，等待负责人批准具体查询范围' } });
        job.status = 'completed'; job.nextJobId = nextJob.id;
        job.events.push({ id: createId('EVT'), at: job.updatedAt, type: 'environment_approval_requested', nextJobId: nextJob.id });
        state.jobs.push(nextJob);
      }
      // Runtime evidence returns to source investigation on the same question, without
      // carrying an environment grant into the source worker or dispatching a write job.
      if (event.type === 'completed' && job.status === 'completed' && job.taskIntent === 'analysis'
        && job.environmentAccess && job.questionId && event.result?.outcome === 'partial'
        && completionRouting.resumeInvestigation && completionRouting.agentRole === 'developer'
        && completionRouting.agentProfile) {
        nextJob = makeNextJob(job, 'developer', completionRouting, job.updatedAt);
        delete nextJob.environmentAccess;
        Object.assign(nextJob, { workflow: 'analysis_review', sourceEnvironment: job.environmentAccess.tier,
          instruction: job.originalQuestion ?? job.instruction,
          delegation: { fromStage: job.stage, toStage: 'developer', reason: '结合环境证据继续调查原问题，按缺口选择下一步工具' } });
        job.nextJobId = nextJob.id;
        job.events.push({ id: createId('EVT'), at: job.updatedAt, type: 'investigation_resumed', nextJobId: nextJob.id });
        state.jobs.push(nextJob);
      }
      // Only this explicitly read-only edge may bypass the human delivery gate.
      // Persist completion and successor together; duplicate/late leases are rejected above.
      if (event.type === 'completed' && job.status === 'awaiting_approval'
        && job.taskIntent === 'analysis' && job.workflow === 'analysis_review' && job.stage === 'developer'
        && ['ready', 'partial'].includes(event.result?.outcome) && completionRouting.agentRole === 'owner_report'
        && completionRouting.agentProfile) {
        nextJob = makeNextJob(job, 'owner_report', completionRouting, job.updatedAt);
        job.status = 'completed';
        job.nextJobId = nextJob.id;
        job.events.push({ id: createId('EVT'), at: job.updatedAt, type: 'analysis_handoff', nextJobId: nextJob.id });
        state.jobs.push(nextJob);
      }
      return { job: structuredClone(job), event: entry, nextJob: nextJob ? structuredClone(nextJob) : null };
    });
  }

  async approve(jobId, approverId, routing = {}, effectKey = null, guard = () => {}) {
    return this.transactEffect(effectKey, (state) => {
      const job = requireJob(state, jobId);
      guard(state, job);
      if (job.status !== 'awaiting_approval') throw new Error(`Job ${jobId} is not awaiting approval`);
      const stage = nextStage(job.workflow, job.stage);
      if (!stage) throw new Error(`Job ${jobId} has no next stage`);
      const now = new Date().toISOString();
      job.status = 'completed';
      job.approvedBy = approverId ?? 'unknown';
      job.approvedAt = now;
      job.updatedAt = now;
      const nextJob = {
        ...structuredClone(job),
        id: createId('JOB'),
        sourceMessageId: null,
        replyToMessageId: job.replyToMessageId,
        stage,
        agentRole: routing.agentRole ?? stage,
        agentProfile: routing.agentProfile ?? null,
        context: [...job.context, { stage: job.stage, result: job.result }],
        attachmentRefs: [],
        attachments: job.attachments,
        status: 'queued',
        lease: null,
        events: [],
        result: null,
        approvedBy: undefined,
        approvedAt: undefined,
        createdAt: now,
        updatedAt: now,
      };
      state.jobs.push(nextJob);
      return { job: structuredClone(job), nextJob: structuredClone(nextJob) };
    });
  }

  async resumeClarification(jobId, input, effectKey = null, guard = () => {}) {
    return this.transactEffect(effectKey, (state) => {
      const job = requireJob(state, jobId);
      guard(state, job);
      if (job.status !== 'awaiting_clarification') {
        throw new Error(`Job ${jobId} is not awaiting clarification`);
      }
      const now = new Date().toISOString();
      job.context.push({ stage: job.stage, result: job.result, kind: 'clarification_requested' });
      job.instruction = `${job.instruction}\n\n用户补充信息：${input.instruction}`.trim();
      job.attachments.push(...(input.attachments ?? []).filter((item) => !job.attachments.some((old) => old.id === item.id)));
      job.sourceInstructionMessageId = input.sourceMessageId ?? job.sourceInstructionMessageId ?? null;
      job.replyToMessageId = input.replyToMessageId ?? input.sourceMessageId ?? job.replyToMessageId;
      job.lastActorId = input.senderId ?? job.lastActorId ?? null;
      job.status = 'queued';
      job.result = null;
      job.lease = null;
      job.events.push({ id: createId('EVT'), at: now, type: 'clarification_received', message: input.instruction });
      job.updatedAt = now;
      if (input.sourceMessageId) state.processedMessages[input.sourceMessageId] = job.id;
      return structuredClone(job);
    });
  }

  async cancel(jobId, senderId, effectKey, guard = () => {}) {
    return this.transactEffect(effectKey, (state) => {
      const job = requireJob(state, jobId);
      guard(state, job);
      if (!['running', 'queued', 'awaiting_instruction', 'awaiting_clarification', 'awaiting_approval', 'awaiting_environment_approval'].includes(job.status)) {
        throw new Error('当前任务已结束或正在停止，不能重复取消。');
      }
      job.status = job.status === 'running' ? 'cancelling' : 'cancelled';
      job.updatedAt = new Date().toISOString();
      job.events.push({ type: job.status === 'cancelling' ? 'cancel_requested' : 'cancelled', by: senderId, at: job.updatedAt });
      return structuredClone(job);
    });
  }
}

function makeNextJob(job, stage, routing, now) {
  return { ...structuredClone(job), id: createId('JOB'), sourceMessageId: null,
    stage, agentRole: stage, agentProfile: routing.agentProfile,
    delegation: { fromStage: job.stage, toStage: stage, reason: '只读分析完成，交给项目负责人汇总' },
    context: [...job.context, { stage: job.stage, result: job.result }],
    status: 'queued', lease: null, events: [], result: null, notificationIds: [],
    nextJobId: undefined, approvedBy: undefined, approvedAt: undefined,
    createdAt: now, updatedAt: now };
}

function needsClarification(job, result) {
  if (result?.outcome) return result.outcome === 'needs_clarification';
  if (job.stage !== 'owner_intake') return false;
  const finalMessage = String(result?.finalMessage ?? result?.message ?? '');
  return /\[NEEDS_CLARIFICATION\]|待需求澄清|暂不可进入(?:需求设计|开发)|(?:事实|信息|需求).{0,16}(?:不足|不完整).{0,24}(?:补充|停止|无法)/i.test(finalMessage);
}

function requireJob(state, id) {
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  return job;
}
