import { SharedChromeBrowser } from './shared-chrome-browser.js';
import { WebsiteBrowser } from './website-browser.js';
import { prepareWebsiteQuery } from './website-query.js';
import { loadEnvironments, planQuery, verifyApprovedPlan } from '../shared/environment-access.js';
import { publishQuestion } from './questions.js';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { controlConfig, loadAgents, loadProjects, saveProjects } from './config.js';
import { FeishuClient, parseFeishuMessage } from './feishu.js';
import { LarkCliFeishuClient } from './lark-cli.js';
import { JsonStore } from '../shared/store.js';
import { nextStage, routeInstruction, routeInstructionForStage, stageLabel } from '../shared/protocol.js';

import { loadConversationSettings } from './conversation-settings.js';
import { loadMemorySettings } from './memory.js';
import { ConversationService, splitReply, responseMessageId } from './conversations.js';
import { LiveCards } from './live-cards.js';
import { jobCard, resultSummary } from './message-cards.js';
import { handleCardAction } from './card-actions.js';
import { jobTerminalMention } from './requester-mention.js';

export async function createControlPlane(overrides = {}) {
  const config = controlConfig(overrides);
  await loadEnvironments();
  const projects = overrides.projects ?? await loadProjects(config.projectsFile);
  const agents = overrides.agents ?? await loadAgents(config.agentsFile);
  const store = new JsonStore(config.storeFile);
  await store.reconcileLegacyResults();
  const feishu = overrides.feishuClient ?? (config.feishu.transport === 'lark-cli'
    ? new LarkCliFeishuClient({ ...config.feishu, dataDir: config.dataDir })
    : new FeishuClient({ ...config.feishu, dataDir: config.dataDir }));

  const authorizeBrowser = async (initial,waiting,request)=>{const current=await store.getJob(initial.id);if(current?.status==='awaiting_clarification'&&current?.result?.browserLoginRequired){const type=request.resourceType();const tail=new URL(request.url()).pathname.split('/').at(-1);return type==='document'||['script','stylesheet','image','font'].includes(type)||/^(login|signin|authenticate|auth|captcha|verify)$/i.test(tail);}if(current?.status!=='running')return false;verifyApprovedPlan(await loadEnvironments(),current.environmentAccess);return true;};
  const browserMode = process.env.AGENTOS_BROWSER_MODE ?? (process.platform === 'darwin' ? 'shared-chrome' : 'isolated');
  if (!['shared-chrome','isolated'].includes(browserMode)) throw new Error('Invalid AGENTOS_BROWSER_MODE');
  const context = { config, projects, agents, store, feishu, websiteBrowser: browserMode === 'shared-chrome' ? new SharedChromeBrowser(authorizeBrowser) : new WebsiteBrowser(config.dataDir,undefined,authorizeBrowser) };
  const cards = new LiveCards(store, feishu);
  context.cards = cards;
  context.notifyJobEvent = (result) => notifyJobEvent(context, result);
  // Upgrade previously sent owned job cards in place; never create or execute a task during migration.
  if (cards.enabled) await store.transact((state) => {
    for (const job of state.jobs) {
      const attempt = job.events.filter((e) => e.type === 'started').at(-1)?.id ?? 'first';
      const saved = state.cardMessages?.[`job:${job.id}:${attempt}`];
      if (!saved?.messageId || saved.actionsVersion === 2 || saved.destination.profile !== job.agentProfile) continue;
      saved.card = jobCard(job);
      saved.terminal = !['queued', 'running', 'cancelling'].includes(job.status);
      saved.revision++;
      saved.actionsVersion = 2;
      saved.updatedAt = new Date().toISOString();
    }
  });
  const conversations = new ConversationService(context, { ...await loadConversationSettings(config.conversationFile), memorySettings: await loadMemorySettings(config.memoryFile), ...overrides.conversationOptions, decide: overrides.conversationResponder });
  context.conversations = conversations;
  const server = http.createServer(async (request, response) => {
    try {
      await route({ ...context, request, response });
    } catch (error) {
      console.error('[control-plane]', error);
      if (!response.headersSent) json(response, error.statusCode ?? 500, { ok: false, error: error.message });
      else response.destroy();
    }
  });

  server.once('listening', () => { cards.start(); conversations.start().catch((error) => console.error('[conversation-start]', error.message)); });
  server.once('close', () => { conversations.stop(); cards.stop(); void context.websiteBrowser.close(); });
  return { server, config, projects, agents, store, conversations, cards };
}

async function route(context) {
  const { request, response, config, store } = context;
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, { ok: true, service: 'agentos-control-plane', conversationEngine: 'codex', conversationProtocol: 3,
      conversationScope: 'question-profile-project-v2',
      questionCards: context.conversations.questionCards, environmentAccessPolicy: 'scoped-read-query-approval-v1',
      memoryPolicy: 'question-native-or-sender-extractive-v2', memoryStatus: context.conversations.memory.status,
      conversationTransport: 'app-server-stdio', conversationConcurrency: context.conversations.concurrency,
      messagePresentation: context.cards?.enabled ? 'live-cards-v1' : 'text', cardActions: 'v1-lease-fenced',
      analysisWorkflow: 'read-only-developer-owner-v1', sourcePolicy: 'folder-evidence-v1', analysisSourcePolicy: 'origin-ff-before-analysis-v1', analysisSnapshotPolicy: 'isolated-environment-source-v1',
      resultPresentation: 'summary-paged-v1', identityPolicy: 'profile-linked-human-v1',
      executionPolicy: 'admin-write-members-analysis-v1', harnessPolicy: 'standard-handoff-v1', now: new Date().toISOString() });
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/feishu') {
    const body = await readJson(request);
    if (!verifyFeishu(body, config.feishu.verificationToken)) return json(response, 403, { ok: false });
    if (body.challenge) return json(response, 200, { challenge: body.challenge });
    json(response, 200, { code: 0 });
    setImmediate(() => handleFeishuEvent(context, body).catch((error) => console.error('[feishu-event]', error)));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/dev/messages') {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const created = await createJobFromMessage(context, {
      messageId: body.messageId,
      chatId: body.chatId,
      senderId: body.senderId ?? 'local-user',
      projectId: body.projectId,
      text: body.text,
      resources: [],
    });
    return json(response, created.duplicate ? 200 : 201, { ok: true, ...created });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/events/lark-cli') {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const created = await handleLarkCliEvent(context, body);
    return json(response, created?.duplicate ? 200 : 201, { ok: true, ...(created ?? {}) });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/events/card-action') {
    requireBearer(request, config.adminToken, 'admin');
    const result = await handleCardAction(context, await readJson(request));
    return json(response, 200, result);
  }

  const environmentMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/environment-claim$/);
  if (request.method === 'POST' && environmentMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const plan = await store.claimEnvironment(decodeURIComponent(environmentMatch[1]), await readJson(request));
    return json(response, 200, { ok: true, plan });
  }

  const controlMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/control$/);
  if (request.method === 'POST' && controlMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(controlMatch[1]));
    if (!job?.lease || job.lease.id !== body.leaseId || job.lease.runnerId !== body.runnerId) {
      return json(response, 409, { ok: false, error: 'Stale or foreign Runner lease' });
    }
    return json(response, 200, { ok: true, cancelRequested: job.status === 'cancelling' });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/runners/heartbeat') {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const runner = await store.heartbeat(body);
    return json(response, 200, { ok: true, runner });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/jobs/lease') {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const job = await store.leaseNext(body.runnerId, body.capabilities ?? []);
    return json(response, 200, { ok: true, job });
  }

  const websiteMatch=url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/website-tool$/);
  if(request.method==='POST'&&websiteMatch){
    requireBearer(request,config.runnerToken,'runner');const body=await readJson(request);const job=await store.getJob(decodeURIComponent(websiteMatch[1]));
    if(job?.status!=='running'||!job.lease?.id||body.leaseId!==job.lease.id||body.runnerId!==job.lease.runnerId)return json(response,409,{error:'Stale or foreign Runner lease'});
    const e=verifyApprovedPlan(await loadEnvironments(),job.environmentAccess??{});if(e.kind!=='website')throw new Error('Not a website grant');
    const result=await context.websiteBrowser.run(job,e,body.tool,body.args);return json(response,200,{result});
  }
  const eventMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/events$/);
  if (request.method === 'POST' && eventMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(eventMatch[1]));
    if (!job?.lease?.id || body.leaseId !== job.lease.id || body.runnerId !== job.lease.runnerId) {
      return json(response, 409, { ok: false, error: 'Stale or foreign Runner lease' });
    }
    let routing = agentRouting(context, nextStage(job.workflow, job.stage));
    if(body.type==='completed'&&body.result?.websiteQuery){
      if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||!job.questionId||job.environmentAccess||body.result.outcome!=='needs_clarification'||body.result.environmentQuery)throw new Error('当前阶段不能申请网页排查');
      body.result.environmentQuery=await prepareWebsiteQuery(context,job,body.result.websiteQuery);
    }
    if (body.type === 'completed' && body.result?.environmentQuery) {
      try {
        if (job.taskIntent !== 'analysis' || !['developer', 'owner_report'].includes(job.stage) || !job.questionId || job.environmentAccess
          || body.result.outcome !== 'needs_clarification') throw new Error('当前阶段不允许申请环境查询');
        const earlier = (await store.read()).jobs.filter(j => j.questionId === job.questionId && j.environmentAccess);
        const request = body.result.environmentQuery;
        if (earlier.some(j => j.environmentAccess.environmentId === request.environmentId
          && j.environmentAccess.queryId === request.queryId
          && JSON.stringify(j.environmentAccess.parameters) === JSON.stringify(request.parameters))) {
          throw new Error('重复环境查询，需要调整范围或补充新证据');
        }
        const plan = planQuery(await loadEnvironments(), body.result.environmentQuery, job.projectId,
          { senderId: job.senderId, profile: job.originProfile });
        routing = { ...agentRouting(context, 'developer'), environmentPlan: { ...plan,
          ...(plan.kind==='website'?{}:{approvalRequired: true, approvedBy: null, approvedAt: null}) } };
        if (!routing.agentProfile) throw new Error('开发角色未配置');
      } catch (error) {
        const repeated = error.message === '重复环境查询，需要调整范围或补充新证据';
        body.result = { ...body.result, outcome: 'blocked', environmentQuery: null,
          summary: repeated ? '该范围已在本问题查询过，本次未重复执行。请结合已有结果调整查询目标或补充新证据。' : '本次环境查询申请未通过范围检查；未访问环境。请在本机核对模板、参数、项目和审批人。',
          finalMessage: '源码阶段提出的环境查询申请无效；未访问环境，原始源码证据保留在阶段记录中。' };
      }
    }
    if (body.type === 'completed' && job.taskIntent === 'analysis' && job.questionId
      && job.environmentAccess && ['partial', 'ready'].includes(body.result?.outcome)
      && context.projects.projects[job.projectId]?.analysisRepositories?.length) {
      const prior = (await store.read()).jobs.filter(j => j.questionId === job.questionId && j.environmentAccess && j.id !== job.id && j.result?.environmentEvidence);
      const hash = body.result.environmentEvidence?.resultHash;
      const stalled = hash && prior.length >= 2 && prior.slice(-2).every(j => j.result.environmentEvidence.resultHash === hash);
      if (!stalled) routing = { ...agentRouting(context, 'developer'), resumeInvestigation: true };
      else body.result.summary = '连续三轮环境调查没有新增证据，已暂停。需要调整调查路径或补充缺失工具。' + (body.result.summary ?? '');
    }
    if (body.type === 'completed' && job.taskIntent === 'analysis' && job.questionId
      && !job.environmentAccess && job.stage === 'owner_report' && body.result?.outcome === 'partial'
      && context.projects.projects[job.projectId]?.analysisRepositories?.length) {
      routing = { ...agentRouting(context, 'developer'), reviewInvestigation: true };
    }
    const result = await store.appendEvent(job.id, body, routing);
    if(['completed','failed','cancelled'].includes(body.type)&&!body.result?.browserLoginRequired)await context.websiteBrowser.release(job.id);
    setImmediate(() => notifyJobEvent(context, result).catch((error) => console.error('[notify]', error)));
    return json(response, 200, { ok: true, job: result.job });
  }

  const approveMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/approve$/);
  if (request.method === 'POST' && approveMatch) {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(approveMatch[1]));
    const nextRole = job ? nextAgentRole(job, context) : null;
    const approved = await store.approve(
      decodeURIComponent(approveMatch[1]),
      body.approverId,
      agentRouting(context, nextRole),
    );
    return json(response, 201, { ok: true, ...approved });
  }

  const attachmentMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === 'GET' && attachmentMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const job = await store.getJob(decodeURIComponent(attachmentMatch[1]));
    const attachment = job?.attachments.find((item) => item.id === decodeURIComponent(attachmentMatch[2]));
    if (!attachment) return json(response, 404, { ok: false, error: 'Attachment not found' });
    const info = await stat(attachment.path);
    response.writeHead(200, {
      'content-type': attachment.contentType ?? 'application/octet-stream',
      'content-length': info.size,
      'content-disposition': `attachment; filename="${attachment.id}"`,
    });
    return createReadStream(attachment.path).pipe(response);
  }

  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (request.method === 'GET' && jobMatch) {
    requireBearer(request, config.adminToken, 'admin');
    const job = await store.getJob(decodeURIComponent(jobMatch[1]));
    return job ? json(response, 200, { ok: true, job }) : json(response, 404, { ok: false });
  }

  json(response, 404, { ok: false, error: 'Not found' });
}

async function handleFeishuEvent(context, envelope) {
  if (envelope.header?.event_type !== 'im.message.receive_v1') return;
  const event = envelope.event ?? {};
  const message = event.message ?? {};
  if (['app', 'bot'].includes(event.sender?.sender_type)) return;
  const parsed = parseFeishuMessage(message);
  const attachments = [];
  for (const resource of parsed.resources) {
    const item = await context.feishu.downloadMessageResource(message.message_id, message.message_id, resource.key, resource.type);
    if (item) attachments.push(item);
  }
  return handleLarkCliEvent(context, {
    type: 'im.message.receive_v1', message_id: message.message_id,
    chat_id: message.chat_id, chat_type: message.chat_type,
    sender_id: event.sender?.sender_id?.open_id, sender_type: 'user',
    content: parsed.text, mentions: message.mentions, attachments,
    reply_to: message.parent_id, root_id: message.root_id, thread_id: message.thread_id,
    agent_role: context.config.feishu.role ?? 'owner_intake',
    agent_profile: context.config.feishu.profile ?? null,
  });
}

export async function handleLarkCliEvent(context, event) {
  if (event.type !== 'im.message.receive_v1' || ['bot', 'app'].includes(event.sender_type)) return null;
  if (context.projects.retiredChatIds?.includes(event.chat_id)) return { ignored: true, reason: 'retired_group' };
  const messageId = event.message_id ?? event.id;
  const role = event.agent_role ?? 'owner_intake';
  const sourceProfile = event.agent_profile ?? null;
  const agent = Object.values(context.agents.agents ?? {}).find((item) => (item.profile || null) === sourceProfile);
  if (event.agent_role && context.agents.agents?.[role]?.profile
    && context.agents.agents[role].profile !== sourceProfile) throw new Error('Agent role/profile mismatch');
  const mentions = event.mentions ?? [];
  const mentionIds = mentions.flatMap((item) => [item.id?.open_id ?? item.id, item.open_id, item.user_id]).filter(Boolean);
  const addressed = event.chat_type === 'p2p' || (agent?.openId && mentionIds.includes(agent.openId));
  const state = await context.store.read();
  const related = (state.conversations ?? []).some((turn) => turn.chatId === event.chat_id && turn.profile === sourceProfile
    && [event.reply_to, event.root_id].filter(Boolean).some((id) => turn.messageId === id || turn.feedbackMessageId === id || turn.responseIds?.includes(id)));
  const jobReply = state.jobs.some((job) => job.chatId === event.chat_id
    && job.agentProfile === sourceProfile && job.notificationIds?.includes(event.reply_to));
  const cardReply = Object.values(state.cardMessages ?? {}).some((card) => card.messageId && card.messageId === event.reply_to
    && card.destination.profile === sourceProfile && (card.destination.chatId === event.chat_id
      || (state.conversations ?? []).some((turn) => turn.chatId === event.chat_id && turn.messageId === card.destination.replyTo)));
  // Older CLI events omit chat_type; their subscription is already bot-scoped.
  // Known group events require an actual mention or a recorded conversation reply.
  if (event.chat_type === 'group' && !addressed && !related && !jobReply && !cardReply) return { ignored: true };
  if (mentionIds.length && agent?.openId && !mentionIds.includes(agent.openId)) return { ignored: true };
  return context.conversations.enqueue({
    ...event, message_id: messageId, agent_role: role,
    content: stripMentions(event.content, mentions),
  });
}

function stripMentions(text, mentions = []) {
  let result = String(text ?? '');
  for (const mention of mentions ?? []) {
    if (mention.key) result = result.replaceAll(mention.key, ' ');
    if (mention.name) result = result.replaceAll(`@${mention.name}`, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

async function createJobFromMessage(context, input) {
  const { projects, store, feishu } = context;
  const projectId = input.projectId ?? projects.chatProjectMap[input.chatId];
  if (!projectId || !projects.projects[projectId]) {
    throw new Error(`Chat ${input.chatId ?? '<unknown>'} is not bound to a project`);
  }
  const routed = input.agentRole
    ? routeInstructionForStage(input.text, input.agentRole)
    : routeInstruction(input.text);
  const assigned = agentRouting(context, routed.stage);
  const requestedAgentRole = input.agentRole ?? routed.stage;
  const requestedAgentProfile = input.agentProfile ?? assigned.agentProfile;
  const delegation = routed.delegated ? {
    fromStage: routed.requestedStage,
    toStage: routed.stage,
    reason: routed.delegationReason,
  } : null;
  if (input.parentMessageId && routed.instruction) {
    const activated = await store.activateDraft(input.parentMessageId, {
      sourceMessageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      workflow: routed.workflow,
      stage: routed.stage,
      instruction: routed.instruction,
      agentRole: routed.stage,
      agentProfile: assigned.agentProfile,
      requestedAgentRole,
      requestedAgentProfile,
      delegation,
    });
    if (activated) return { job: activated, duplicate: false, activatedDraft: true };
  }
  const status = routed.instruction ? 'queued' : 'awaiting_instruction';
  const created = await store.createJob({
    projectId,
    projectName: projects.projects[projectId].displayName ?? projectId,
    chatId: input.chatId,
    senderId: input.senderId,
    originProfile: input.agentProfile ?? null,
    originChatType: input.chatType ?? null,
    agentRole: routed.stage,
    agentProfile: assigned.agentProfile,
    requestedAgentRole,
    requestedAgentProfile,
    delegation,
    sourceMessageId: input.messageId,
    replyToMessageId: input.replyToMessageId,
    workflow: routed.workflow,
    stage: routed.stage,
    instruction: routed.instruction,
    attachmentRefs: input.resources,
    attachments: input.attachments ?? [],
    status,
  });
  if (created.duplicate) return created;
  for (const resource of input.resources) {
    const attachment = await feishu.downloadMessageResource(
      created.job.id, input.messageId, resource.key, resource.type,
      { profile: input.agentProfile },
    );
    if (attachment) await store.addAttachment(created.job.id, attachment);
  }
  return { ...created, job: await store.getJob(created.job.id) };
}

export async function notifyJobEvent(context, { job, event }) {
  if (!job.chatId && !job.replyToMessageId) return;
  if (context.cards?.enabled) {
    if (!['queued', 'started', 'completed', 'failed', 'cancelled', 'cancel_requested', 'progress'].includes(event.type)) return;
    if (event.type === 'progress' && !['codex_waiting', 'codex_working', 'connection_retry', 'verification', 'tool_activity'].includes(event.phase)) return;
    // Always re-read authoritative state; HTTP event notifications may arrive out of order.
    const current = await context.store.getJob(job.id);
    if (current.questionId) { await publishQuestion(context, current.questionId); return; }
    const terminal = !['queued', 'running', 'cancelling'].includes(current.status);
    const attempt = current.events.filter((e) => e.type === 'started').at(-1)?.id ?? 'first';
    const key = `job:${job.id}:${attempt}`;
    // Once queued, keep the exact recipients across retries/config changes.
    const frozenMention = (await context.store.read()).cardMessages?.[key]?.terminalMention;
    const id = await context.cards.upsert(key, jobCard(current),
      { chatId: current.chatId, replyTo: current.chatId ? null : current.replyToMessageId, profile: current.agentProfile },
      { terminal, immediate: terminal, resultText: terminal ? current.result?.finalMessage : '',
        terminalMention: frozenMention ?? jobTerminalMention(current, context.projects) });
    if (id) await context.store.transact((state) => {
      const saved = state.jobs.find((item) => item.id === job.id);
      saved.notificationIds = [...new Set([...(saved.notificationIds ?? []), id])];
    });
    return;
  }
  if (event.type === 'progress') {
    const labels = { codex_waiting: 'Codex 已启动，正在等待模型响应', codex_working: 'Codex 仍在处理当前任务，尚未完成',
      connection_retry: 'Codex 连接异常，正在重试；尚未完成', verification: 'Codex 已返回，正在执行配置的验证命令' };
    if (!Object.hasOwn(labels, event.phase)) return; // Never publish raw commands, logs or credentials.
    const accepted = await context.store.transact((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (!current || current.status !== 'running') return false;
      if (current.progressNoticeAt && Date.now() - Date.parse(current.progressNoticeAt) < 60_000 && event.phase !== 'verification') return false;
      current.progressNoticeAt = new Date().toISOString();
      return true;
    });
    if (accepted) await sendAsJobAgent(context, job, `${job.id} · ${stageLabel(job.stage)}\n${labels[event.phase]}。已运行约 ${Math.max(0, Math.round(Number(event.elapsedSeconds) || 0))} 秒。`);
  }
  if (event.type === 'started') {
    await sendAsJobAgent(context, job, `${job.id} 已开始：${stageLabel(job.stage)}`);
  }
  if (event.type === 'completed') {
    const conclusion = resultSummary(job.result?.summary || job.result?.finalMessage) || '执行器未返回文字结论，请查看任务记录。';
    const status = job.status === 'awaiting_clarification'
      ? '当前阶段等待补充信息，尚未通过。可直接回复具体补充内容。'
      : job.status === 'awaiting_approval'
        ? '当前阶段待真人管理员确认。可 @项目负责人 说明是否同意进入下一阶段。'
        : job.status === 'blocked' ? '当前阶段未通过，不能放行；请根据以下结论安排修复。'
          : '当前阶段已结束。';
    for (const part of splitReply(`${job.id} · ${stageLabel(job.stage)}\n${status}\n\n${conclusion}`)) {
      await sendAsJobAgent(context, job, part);
    }
  }
  if (event.type === 'failed') {
    await sendAsJobAgent(context, job, `${job.id} 执行失败，未通过当前阶段。错误详情已记录在本地任务日志，请管理员查看。`);
  }
}

function agentRouting(context, role) {
  const profileRole = role === 'owner_report' ? 'owner_intake' : role;
  const agent = profileRole ? context.agents?.agents?.[profileRole] : null;
  return { agentRole: role, agentProfile: agent?.profile ?? null };
}

function nextAgentRole(job) {
  return nextStage(job.workflow, job.stage);
}

async function sendAsJobAgent({ feishu, store }, job, text) {
  let result;
  if (job.chatId && typeof feishu.send === 'function') {
    result = await feishu.send(job.chatId, text, { profile: job.agentProfile });
  }
  else if (job.replyToMessageId) result = await feishu.reply(job.replyToMessageId, text, { profile: job.agentProfile });
  const id = responseMessageId(result);
  if (id) await store.transact((state) => {
    const saved = state.jobs.find((item) => item.id === job.id);
    if (saved) { saved.notificationIds ??= []; saved.notificationIds.push(id); }
  });
  return result;
}

function verifyFeishu(body, expected) {
  if (!expected) return true;
  return body.token === expected || body.header?.token === expected;
}

function requireBearer(request, expected, kind) {
  if (!expected) throw new Error(`${kind} token is not configured`);
  if (request.headers.authorization !== `Bearer ${expected}`) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

async function readJson(request, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length });
  response.end(encoded);
}

async function main() {
  const { server, config } = await createControlPlane();
  server.listen(config.port, config.host, () => {
    console.log(`[control-plane] listening on http://${config.host}:${config.port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
