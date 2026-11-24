import { receptionSensitive } from '../shared/reception-policy.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createId } from '../shared/protocol.js';
import { createJobRecord } from '../shared/store.js';
import { resolveProjectId } from '../shared/project-scope.js';
import { confirmedSourceEnvironment, selectSourceEnvironment, sourceEnvironmentConflict, sourceEnvironmentForTier } from '../shared/source-environments.js';
import { prdStart, requestsPrd, prdExport, prdDelivered, prdFormVersion } from '../shared/prd-workspace.js';
import { previousPrdDelivery } from '../shared/prd-revision.js';
import { requestsPrivateCard } from './private-cards.js';
import { publishQuestion, questionJob } from './questions.js';
import { stateView } from '../shared/state-view.js';
import { PrdCloudDelivery } from './prd-cloud-delivery.js';
import { normalizePrdDraftLinks, readPrdDraft } from './prd-drafts.js';

const editableStates = new Set(['completed', 'awaiting_clarification', 'failed', 'blocked']);
const active = new Set(['queued', 'running', 'cancelling']);

export async function loadPrdWorkspace(config) {
  const file = path.join(path.dirname(config.dataDir), 'prd-workspace.local.json');
  const value = await readFile(file, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  if (!Array.isArray(value.chatIds ?? []) || (value.chatIds ?? []).some(id => !/^oc_[a-zA-Z0-9]+$/.test(id))) throw Error('PRD workspace group scope is invalid');
  if (value.publishers !== undefined && (!value.publishers || typeof value.publishers !== 'object' || Array.isArray(value.publishers)
    || Object.entries(value.publishers).some(([profile,publisher]) => !/^[A-Za-z0-9_-]+$/.test(profile)
      || !/^ou_[A-Za-z0-9]+$/.test(publisher?.ownerOpenId ?? '') || !Array.isArray(publisher.chatIds)
      || publisher.chatIds.some(id => !value.chatIds?.includes(id))))) throw Error('PRD workspace publishers are invalid');
  return value;
}

export class PrdWorkspace {
  constructor(context, settings = {}, dependencies = {}) {
    this.context = context;
    this.chatIds = new Set(settings.chatIds ?? []);
    this.readDraft = dependencies.readDraft ?? (input => readPrdDraft(context.feishu, {
      ...input, readOwnerMembers: token => this.publisher.readDraftMembers(input, token),
    }));
    this.draftReads = new Map();
    this.publisher = new PrdCloudDelivery(context, settings.publisher, {publishers:settings.publishers,...dependencies, onPublished: id => this.resumePending(id)});
  }

  async handle(event, { agent, addressed, content, form, recoverQuestionId }) {
    if (event.chat_type !== 'group' || event.sender_type !== 'user' || !agent?.systemAssistant
      || !this.context.cards?.enabled || !this.chatIds.has(event.chat_id) || !event.message_id || !event.sender_id) return null;
    if (!addressed && !form) return null;
    const lineage = [event.root_id, event.reply_to, event.message_id].filter(Boolean);
    const possible = await stateView(this.context.store, state => Object.values(state.questions ?? {}).some(q =>
      q.prd && q.profile === event.agent_profile && q.chatId === event.chat_id && lineage.includes(q.threadRootId)));
    const starts = !form && addressed && requestsPrd(content);
    if (!possible && !starts) return null;
    const { canonical, plainText, links: draftLinks } = normalizePrdDraftLinks(content);
    if (receptionSensitive(plainText)) return { ignored: true, reason: 'prd_sensitive_group_input' };
    content = canonical;
    if (requestsPrivateCard(content)) return { ignored: true, reason: 'prd_public_group_only' };
    const accepted = await this.context.store.transact(state => {
      state.questions ??= {};
      state.conversations ??= [];
      let q = Object.values(state.questions).find(q => q.prd && q.profile === event.agent_profile && q.chatId === event.chat_id && lineage.includes(q.threadRootId));
      let recoveredTurn;
      if (!q && recoverQuestionId && starts) {
        const existing = state.questions[recoverQuestionId];
        const turn = state.conversations.find(t => t.id === existing?.rootTurnId);
        if (!existing || !turn || existing.withdrawnAt || existing.prd || existing.visibility === 'requester'
          || existing.messageId !== event.message_id || existing.threadRootId !== existing.messageId
          || existing.senderId !== event.sender_id || existing.chatId !== event.chat_id
          || existing.profile !== event.agent_profile || existing.latestTurnId !== turn?.id
          || turn.questionId !== existing.id || turn.messageId !== existing.messageId
          || turn.senderId !== existing.senderId || turn.chatId !== existing.chatId || turn.profile !== existing.profile
          || turn.projectId !== existing.projectId || turn.status !== 'sent' || turn.decision?.action !== 'reply'
          || normalizePrdDraftLinks(turn.content).canonical !== canonical || questionJob(state, existing.id)
          || resolveProjectId(this.context.projects, event.chat_id, event.agent_profile) !== existing.projectId) {
          return { ignored: true, reason: 'prd_original_not_recoverable' };
        }
        q = existing;
        q.generation = Math.max(q.generation, q.cardGeneration ?? 1) + 1;
        q.prd = { messages: [], closed: false };
        recoveredTurn = turn;
      }
      if (!q) {
        if (!starts) return { ignored: true };
        // The root message ID is common to all subscribed assistants, so one owns this topic.
        const rootId = event.root_id || event.message_id;
        if (Object.values(state.questions).some(x => x.prd && x.chatId === event.chat_id && x.threadRootId === rootId)) return { ignored: true, reason: 'prd_owned_by_another_assistant' };
        const projectId = resolveProjectId(this.context.projects, event.chat_id, event.agent_profile);
        if (!this.context.projects.projects?.[projectId]) return { ignored: true };
        const id = createId('QST');
        q = state.questions[id] = { id, title: content, messageId: event.message_id, threadRootId: rootId,
          senderId: event.sender_id, chatId: event.chat_id, profile: event.agent_profile, projectId, createdAt: new Date().toISOString(),
          generation: 1, replyInThread: true, prd: { messages: [], closed: false } };
      }
      if (q.withdrawnAt || q.prd.closed || q.senderId !== event.sender_id) return { ignored: true, reason: 'not_prd_requester' };
      const savedMessage = q.prd.messages.find(m => m.id === event.message_id);
      if (savedMessage) {
        if (savedMessage.draftLinks) return { questionId: q.id, draftLinks: savedMessage.draftLinks, projectId: q.projectId };
        return { duplicate: true };
      }
      if (form) {
        const saved = state.cardMessages?.['question:' + q.id];
        const revision = prdFormVersion(q, questionJob(state, q.id));
        if (q.id !== form.questionId || saved?.messageId !== form.cardId || revision !== form.version) return { ignored: true, reason: 'prd_form_stale' };
      }
      const opening = !q.rootTurnId || Boolean(recoveredTurn);
      const firstContent = opening ? content.replace(prdStart, '').replace(/^[\s：:，,。；;]+/, '') : content;
      const id = recoveredTurn?.id ?? createId('CHAT');
      const text = firstContent.trim();
      const j = questionJob(state, q.id);
      const turn = recoveredTurn ?? { id, questionId: q.id, messageId: event.message_id, chatId: q.chatId, chatType: 'group', senderId: q.senderId,
        profile: q.profile, projectId: q.projectId, role: 'developer', content, replyInThread: true, status: 'sent', createdAt: new Date().toISOString(),
        response: '' };
      if (!recoveredTurn) state.conversations.push(turn);
      q.rootTurnId ??= id;
      q.latestTurnId = id;
      const message = { id: event.message_id, turnId: id, text, attachments: event.attachments ?? [] };
      q.prd.messages.push(message);
      if (j?.status === 'cancelling' || j?.status === 'cancelled') return { ignored: true, reason: 'prd_cancelled' };
      if (form) {
        const card = state.cardMessages['question:' + q.id];
        const key = 'prd:' + form.version;
        if (card.terminalMention?.requestKey === key || card.prdReminders?.[key]) {
          card.prdReminders ??= {};
          card.prdReminders[key] = { ...card.prdReminders[key], submitted: true };
        }
      }
      if (draftLinks.length) {
        message.draftLinks = draftLinks;
        delete q.prd.intake;
        if (opening) q.title = '根据飞书初稿整理需求';
        turn.prdDraftReading = true;
        turn.status = 'thinking';
        turn.response = '已收到飞书初稿，正在读取。';
        return { questionId: q.id, draftLinks, projectId: q.projectId };
      }
      if (!text && opening) {
        requestIntake(q, turn, '想做什么需求？直接在卡片里说，或贴飞书需求初稿链接。截图也可以发到这个话题。');
        return { questionId: q.id };
      }
      if (j && (active.has(j.status) || this.publisher.workers.has(q.id))) return { questionId: q.id, pending: true };
      const exportRun = j?.prd?.exportRevision && !q.prd.delivery?.sentAt && prdExport.test(text) && j.result?.outcome === 'ready';
      if (exportRun) { q.prd.messages.at(-1).applied = true; return { questionId: q.id, retryPublish: true }; }
      if (prdExport.test(text) && prdDelivered(q, j) && j?.prd?.exportRevision === j?.prd.revision) {
        q.prd.messages.at(-1).applied = true;
        return { questionId: q.id };
      }
      applyPending(state, q, this.context.projects.projects[q.projectId]);
      return { questionId: q.id };
    });
    if (accepted.draftLinks) return this.readDrafts(accepted, event);
    if (accepted.questionId && (!accepted.pending || form)) await publishQuestion(this.context, accepted.questionId).catch(() => {});
    if (accepted.retryPublish) this.publisher.wake(accepted.questionId);
    return accepted;
  }

  readDrafts(input, event) {
    const key = JSON.stringify([input.questionId, event.message_id]);
    if (this.draftReads.has(key)) return this.draftReads.get(key);
    const task = this.importDrafts(input, event).finally(() => this.draftReads.delete(key));
    this.draftReads.set(key, task);
    return task;
  }

  async resumeDraftImports() {
    const pending = await stateView(this.context.store, state => Object.values(state.questions ?? {})
      .filter(q => q.prd && !q.withdrawnAt && !q.prd.closed)
      .flatMap(q => q.prd.messages.filter(m => m.draftLinks).map(m => ({
        input: { questionId: q.id, projectId: q.projectId, draftLinks: m.draftLinks },
        event: { agent_profile: q.profile, chat_id: q.chatId, message_id: m.id },
      }))));
    await Promise.allSettled(pending.map(({ input, event }) => this.readDrafts(input, event)));
  }

  async refreshOpenForms() {
    const ids = await stateView(this.context.store, state => Object.values(state.questions ?? {}).flatMap(q => {
      if (!q.prd || !this.chatIds.has(q.chatId) || !prdFormVersion(q, questionJob(state, q.id))) return [];
      const saved = state.cardMessages?.['question:' + q.id];
      if (!saved?.messageId || saved.card?.body?.elements?.some(e => e.name === 'prd_answers')) return [];
      return [q.id];
    }));
    for (const id of ids) await publishQuestion(this.context, id).catch(() => {});
  }

  async importDrafts({ questionId, draftLinks, projectId }, event) {
    await publishQuestion(this.context, questionId).catch(() => {});
    const permitted = this.chatIds.has(event.chat_id) && this.context.projects.projects?.[projectId]
      && resolveProjectId(this.context.projects, event.chat_id, event.agent_profile) === projectId;
    const results = permitted ? await Promise.allSettled(draftLinks.map(async url =>
      this.readDraft({ url, projectId, profile: event.agent_profile, chatId: event.chat_id, questionId,
        dataDir: this.context.config.dataDir }))) : [];
    const changed = await this.context.store.transact(state => {
      const q = state.questions[questionId];
      const message = q?.prd.messages.find(m => m.id === event.message_id);
      const turn = state.conversations.find(t => t.id === message?.turnId);
      if (!message?.draftLinks || !turn) return false;
      delete message.draftLinks;
      delete turn.prdDraftReading;
      if (q.withdrawnAt || turn.withdrawnAt || q.prd.closed) {
        message.applied = true;
        return false;
      }
      turn.status = 'sent';
      turn.response = '';
      if (!permitted) {
        message.applied = true;
        turn.response = '当前群或助手的需求工作台配置已变更，已停止读取初稿。';
        return false;
      }
      message.drafts = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      const failure = results.find(r => r.status === 'rejected')?.reason;
      if (failure) {
        message.draftError = failure.code?.startsWith('PRD_DRAFT_') ? failure.message
          : '助手暂时读不到这份飞书文档。请检查是否已共享给本群和对应助手，再提交链接。也可以直接贴初稿。';
        if (!message.drafts.length) message.text = normalizePrdDraftLinks(message.text).plainText.replace(/^[\s，。；、!?！？,.]+|[\s，。；、!?！？,.]+$/g, '');
      }
      if (q.prd.messages.some(m => m.draftLinks)) return true;
      const failedMessage = q.prd.messages.find(m => m.draftError);
      if (failedMessage) {
        requestIntake(q, state.conversations.find(t => t.id === q.latestTurnId) ?? turn, failedMessage.draftError);
        for (const m of q.prd.messages) delete m.draftError;
        return true;
      }
      const job = questionJob(state, q.id);
      if (!job || editableStates.has(job.status) && !this.publisher.workers.has(q.id)) {
        applyPending(state, q, this.context.projects.projects[q.projectId]);
      }
      return true;
    });
    if (changed) await publishQuestion(this.context, questionId).catch(() => {});
    return { questionId };
  }

  async onCompleted(job) {
    if (!job.prd || !job.questionId) return;
    if (editableStates.has(job.status) && await this.resumePending(job.questionId)) return;
    if (job.prd.exportRevision === job.prd.revision && job.status === 'completed' && job.result?.outcome === 'ready') {
      this.publisher.wake(job.questionId);
      return;
    }
  }

  async resumePending(questionId) {
    const changed = await this.context.store.transact(state => {
      const q = state.questions[questionId], j = questionJob(state, questionId);
      if (!q?.prd || q.withdrawnAt || !editableStates.has(j?.status)) return false;
      return applyPending(state, q, this.context.projects.projects[q.projectId]);
    });
    if (changed) await publishQuestion(this.context, questionId).catch(() => {});
    return changed;
  }
}

function prdSourceEnvironment(project, messages) {
  for (const { text } of messages.toReversed()) {
    // PRD is also the name of the deliverable. Only treat it as production
    // when the user labels it as an environment or sends a bare confirmation.
    const selection = confirmedSourceEnvironment(project, text);
    if (selection && /^(?:(?:确认|查|用|使用)\s*)?(?:prd|prod|production|sit|uat|生产|测试)(?:\s*环境)?[。.!！]?$/i.test(text)) return selection;
    const environmentText = text.replace(/\bPRD\b(?!\s*(?:环境|机|库))/gi, '');
    const explicit = confirmedSourceEnvironment(project, environmentText);
    if (explicit) return explicit;
  }
}

function applyPending(state, q, project) {
  if (['creating','created','body_verified','inserting','image_verified','sharing','shared','unknown'].includes(q.prd.delivery?.phase)) return false;
  const pending = q.prd.messages.filter(m => !m.applied && (m.text || m.attachments.length));
  if (!pending.length || pending.some(m => m.draftLinks)) return false;
  let job = questionJob(state, q.id);
  if (job?.environmentAccess || job?.result?.browserLoginRequired || job?.result?.modelCapacityWaiting || job?.result?.environmentConflict) return false;
  const requesterText = pending.map(m => m.text).join('\n');
  const drafts = pending.flatMap(m => m.drafts ?? []);
  const text = [requesterText, ...drafts.map(d => [
    `【飞书需求初稿，用户提供的参考资料】${d.title}`, d.url, d.text,
    ...(d.imageCount ? [`文档含 ${d.imageCount} 个图片块。图片按文档顺序关联到本题视觉附件：`,
      ...(d.imageReferences ?? []).map(ref => `第 ${ref.position} 张：${ref.attachmentId ?? '预览不可用'}`),
      ...(d.imageReferences?.every(ref => ref.attachmentId) ? [] : ['有图片未读到。仅在确实影响需求时，请用户补对应图。'])] : []),
  ].join('\n'))].join('\n\n');
  const head = pending.at(-1), manualExport = prdExport.test(head.text);
  const attachments = [...new Map([...pending.flatMap(m => m.attachments), ...drafts.flatMap(d => d.attachments ?? [])]
    .map(attachment => [attachment.id, attachment])).values()];
  if (!job && manualExport && !pending.slice(0, -1).some(m => m.text || m.attachments.length)) {
    requestIntake(q, state.conversations.find(t => t.id === head.turnId), '请先描述想改的页面、目标和范围。');
    head.applied = true;
    return false;
  }
  if (!job) {
    let sourceEnvironment;
    try {
      const declaredEnvironments = new Set(drafts.flatMap(d => d.text.split('\n').flatMap(line => {
        const value = /^(?:参考环境|源码环境|环境)\s*[：:]\s*(.+)$/.exec(line.trim())?.[1];
        return value ? [prdSourceEnvironment(project, [{ text: value }])] : [];
      })).filter(Boolean));
      const selected = prdSourceEnvironment(project, pending);
      if (!selected && declaredEnvironments.size > 1) throw Error('Conflicting PRD source environments');
      const declared = [...declaredEnvironments][0];
      sourceEnvironment = selected || declared
        ? selectSourceEnvironment(project, selected ?? declared)
        : sourceEnvironmentForTier(project, 'prd');
    }
    catch {
      const prompt = drafts.length
        ? '飞书初稿已读并保留。请确认需要参考的环境；未指定时默认正式环境，请核对项目的正式环境配置。'
        : '请确认要参考的源码环境，例如生产环境或 SIT。前面的需求已保留。';
      requestIntake(q, state.conversations.find(t => t.id === head.turnId), prompt);
      return false;
    }
    if (sourceEnvironmentConflict(project, sourceEnvironment, requesterText)) {
      requestIntake(q, state.conversations.find(t => t.id === head.turnId), '请确认本需求的参考环境，例如生产或 SIT。');
      return false;
    }
    const turn = state.conversations.find(t => t.id === head.turnId);
    const created = createJobRecord(state, { questionId: q.id, projectId: q.projectId, projectName: project.displayName, chatId: q.chatId,
      senderId: q.senderId, agentProfile: q.profile, originProfile: q.profile, originChatType: 'group', agentRole: 'developer', stage: 'developer',
      workflow: 'continuous_analysis', continuousInvestigation: true, taskIntent: 'analysis', sourceEnvironment,
      sourceMessageId: turn.id, replyToMessageId: q.messageId, originalQuestion: text, currentQuestion: text, instruction: text, attachments,
      prd: { revision: 1, exportRevision: 1, auto: true, businessFinal: true, reviewBasis: true, processDesign: true, fixedFinalSections: true, inlinePrototypes: true, nativePrototypeEdits: true, nativeUiCapture: true } });
    job = created.job;
    q.title = (drafts[0]?.title || requesterText).slice(0, 120);
  } else {
    if (!editableStates.has(job.status)) return false;
    const requestedEnvironment = prdSourceEnvironment(project, pending);
    if (requestedEnvironment && requestedEnvironment !== job.sourceEnvironment || sourceEnvironmentConflict(project, job.sourceEnvironment, requesterText)) {
      pending.forEach(m => { m.applied = true; });
      state.conversations.find(t => t.id === head.turnId).response = '当前需求已绑定源码环境。要不同环境的基线，请新开需求，或在本话题补充该环境的资料。';
      return false;
    }
    const revision = job.prd.revision + 1;
    const previous = previousPrdDelivery(q, revision);
    const refreshSource = prdDelivered(q, job) || (job.prd.refreshSource && !job.analysisSourceSnapshot && !job.result?.sourceSync);
    if (refreshSource) {
      delete job.analysisSourceSnapshot;
      delete job.analysisSourceSnapshots;
    }
    job.prd = { revision, exportRevision: revision, auto: true, businessFinal: true, reviewBasis: true, processDesign: true, fixedFinalSections: true, inlinePrototypes: true, nativePrototypeEdits: true, nativeUiCapture: true, ...(refreshSource ? { refreshSource: true } : {}), ...(previous ? { previousRevision: {
      revision: previous.revision, url: previous.url, sentAt: previous.sentAt, digest: previous.digest, artifacts: previous.artifacts,
    } } : {}) };
    if (q.prd.delivery && !q.prd.delivery.sentAt && !q.prd.delivery.token) delete q.prd.delivery;
    if (job.result) job.context = [...job.context, { stage: 'developer', kind: 'prd_previous_turn', result: job.result }].slice(-8);
    job.currentQuestion = manualExport ? '按已确认需求完成本版评审稿。' : text;
    job.instruction = `需求初始描述：${job.originalQuestion}\n本轮补充：${text}`;
    job.attachments = [...new Map([...job.attachments, ...attachments].map(a => [a.id, a])).values()];
    job.status = 'queued';
    job.result = null;
    job.lease = null;
    job.updatedAt = new Date().toISOString();
    job.events.push({ id: createId('EVT'), type: 'prd_continued', at: job.updatedAt, revision });
    q.generation++;
    delete job.investigationProgress;
    delete job.continuousContinuationKeys;
    delete job.continuousRejectedCount;
  }
  delete q.prd.intake;
  for (const m of pending) m.applied = true;
  state.conversations.find(t => t.id === head.turnId).outcome = { jobId: job.id };
  return true;
}

function requestIntake(q, turn, prompt) {
  q.prd.intake = { version: turn.id, prompt };
  turn.response = prompt;
}
