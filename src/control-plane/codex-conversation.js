import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadStageInstruction } from '../runner/codex-executor.js';
import { CodexAppServer } from '../shared/codex-app-server.js';
import { codexEnvironment, conversationServerArgs, loadCodexRuntimeSettings, resolveCodexBinary } from '../shared/codex-runtime.js';

import { SessionRegistry } from './session-registry.js';

const schemaFile = fileURLToPath(new URL('../../config/conversation.schema.json', import.meta.url));
const instructionsFile = fileURLToPath(new URL('../../config/conversation.md', import.meta.url));

export class CodexConversationEngine {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new Map();
    this.registry = new SessionRegistry(options.dataDir ?? './data');
    this.closed = false;
  }

  async start() {
    if (!this.starting) this.starting = this.initialize().catch(async (error) => { await this.app?.close(); this.starting = null; throw error; });
    return this.starting;
  }

  async initialize() {
    if (this.closed) throw new Error('Conversation engine stopped');
    const hash = createHash('sha256').update(path.resolve(this.options.dataDir ?? './data')).digest('hex').slice(0, 12);
    // Outside the business repository: greetings must not load its AGENTS/skills.
    this.cwd = path.join(os.tmpdir(), `agentos-chat-${hash}`);
    await mkdir(this.cwd, { recursive: true });
    const env = await codexEnvironment(this.options);
    if (this.closed) throw new Error('Conversation engine stopped');
    this.app = new CodexAppServer({ cwd: this.cwd, codexBin: await resolveCodexBinary(this.options.codexBin), env, args: conversationServerArgs() });
    await this.app.start();
    const account = await this.app.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') {
      await this.app.close();
      throw new Error('AgentOS 需要本机 Codex 的 ChatGPT 订阅登录态，请先 codex login');
    }
    this.authType = account.account.type;
    this.schema = JSON.parse(await readFile(schemaFile, 'utf8'));
    this.rules = await readFile(instructionsFile, 'utf8');
    return this.app;
  }

  async decide(input, options = {}) {
    const began = Date.now();
    await this.start();
    await this.app.start();
    if (options.signal?.aborted || this.closed) throw new Error('Conversation stopped');
    const runtime = await loadCodexRuntimeSettings(this.options);
    const runtimeSignature = JSON.stringify(runtime);
    const key = options.sessionKey ?? `${input.role}:${input.project?.id ?? ''}`;
    if (input.nativeSession) return this.decidePersistent(input, options, key, began, runtime, runtimeSignature);
    let session = this.sessions.get(key);
    const reused = Boolean(!input.memory?.enabled && session && session.generation === this.app.generation
      && session.runtimeSignature === runtimeSignature && session.count < 20);
    if (!reused) {
      if (session) this.releaseSession(key, session);
      if (this.sessions.size >= 24) {
        const idle = [...this.sessions].filter(([, item]) => !item.active).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (idle) this.releaseSession(...idle);
      }
      const role = await loadStageInstruction(input.role);
      const thread = await this.app.request('thread/start', {
        cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        ...(runtime.model ? { model: runtime.model } : {}),
        developerInstructions: `${this.rules}\n角色职责（仅理解与决策，不能执行工具或角色任务）：\n${role}`,
      });
      session = { id: thread.thread.id, model: thread.model, runtimeSignature, generation: this.app.generation, count: 0, touched: Date.now() };
      this.sessions.set(key, session);
    }
    const preparedMs = Date.now() - began;
    session.active = true;
    try {
      const result = await decisionTurn(this.app, {
        threadId: session.id, effort: runtime.reasoningEffort ?? 'low', approvalPolicy: 'never',
        input: [{ type: 'text', text: `本轮最新上下文（状态以此为准，历史里的操作不可重复执行）：\n${JSON.stringify(input)}` },
          ...(input.attachments ?? []).filter((item) => item.type === 'image').slice(-5).map((item) => ({ type: 'localImage', path: item.path }))],
        outputSchema: this.schema,
      }, { signal: options.signal, timeoutMs: this.options.timeoutMs ?? 90_000, onEvent: options.onEvent });
      session.count++;
      session.active = false;
      session.touched = Date.now();
      return { ...validateDecision(JSON.parse(result.text)), threadId: result.threadId,
        timing: { ...result.timing, preparedMs, aiMs: Date.now() - began, sessionReused: reused, model: session.model,
          reasoningEffort: runtime.reasoningEffort ?? 'low' } };
    } catch (error) {
      // Discard uncertain read-only threads; never overlap a possibly active turn.
      this.releaseSession(key, session);
      throw error;
    }
  }

  async decidePersistent(input, options, key, began, runtime, runtimeSignature) {
    if (!input.requestId) throw new Error('Persistent session requires request identity');
    const role = await loadStageInstruction(input.role);
    const rulesHash = createHash('sha256').update(`${this.rules}\n${role}\n${runtimeSignature}`).digest('hex');
    const saved = await this.registry.get(key);
    if (saved?.lastRequestId === input.requestId && saved.decision) return saved.decision;
    let session = this.sessions.get(key), resumed = false;
    const compatible = saved?.threadId && !saved.pending && saved.rulesHash === rulesHash;
    if (!session || session.generation !== this.app.generation || session.id !== saved?.threadId || !compatible) {
      if (session) this.releaseSession(key, session);
      if (this.sessions.size >= 24) {
        const idle = [...this.sessions].filter(([, item]) => !item.active).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (idle) this.releaseSession(...idle);
      }
      const params = { cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never',
        ...(runtime.model ? { model: runtime.model } : {}),
        developerInstructions: `${this.rules}\n${role}\n这是当前问题的独立会话。每条消息的当前发起人和administrator以本轮输入为准；历史授权不能转授。不同问题分别处理，耗时任务交给Runner，聊天不执行工具。` };
      // Only confirmed missing sessions may start fresh; auth/transport errors must not fork silently.
      let thread;
      if (compatible) {
        thread = await this.app.request('thread/resume', { ...params, threadId: saved.threadId }); resumed = true;
      } else thread = await this.app.request('thread/start', { ...params, ephemeral: false });
      session = { id: thread.thread.id, model: thread.model, runtimeSignature, generation: this.app.generation, active: false, count: 0, touched: Date.now() };
      this.sessions.set(key, session);
    } else resumed = true;
    if (session.active) throw new Error('Concurrent group session turn rejected');
    session.active = true;
    const baseline = { threadId: session.id, rulesHash, pending: input.requestId, updatedAt: new Date().toISOString() };
    try {
      await this.registry.set(key, baseline);
      const payload = { ...input, history: resumed ? [] : input.history };
      const result = await decisionTurn(this.app, { threadId: session.id, effort: runtime.reasoningEffort ?? 'low', approvalPolicy: 'never',
        input: [{ type: 'text', text: `当前真实发起人、权限、问题与任务状态：\n${JSON.stringify(payload)}` },
          ...(input.attachments ?? []).filter((item) => item.type === 'image').slice(-5).map((item) => ({ type: 'localImage', path: item.path }))],
        outputSchema: this.schema }, { signal: options.signal, timeoutMs: this.options.timeoutMs ?? 90_000, onEvent: options.onEvent });
      const decision = { ...validateDecision(JSON.parse(result.text)), threadId: session.id,
        timing: { ...result.timing, aiMs: Date.now() - began, sessionReused: resumed, model: session.model,
          reasoningEffort: runtime.reasoningEffort ?? 'low', nativeSession: true } };
      await this.registry.set(key, { ...baseline, pending: null, lastRequestId: input.requestId, decision });
      session.active = false; session.touched = Date.now();
      return decision;
    } catch (error) { this.releaseSession(key, session); throw error; }
  }

  releaseSession(key, session) {
    this.sessions.delete(key);
    if (session.generation === this.app.generation) {
      this.app.request('thread/unsubscribe', { threadId: session.id }, 3000).catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    this.sessions.clear();
    await this.app?.close();
  }
}

// Standalone callers own their lifecycle; the live service owns one engine.
export async function decideWithCodex(input, options = {}) {
  const engine = new CodexConversationEngine(options);
  try { return await engine.decide(input, options); } finally { await engine.close(); }
}

export class DecisionProtocolError extends Error { constructor(message) { super(message); this.code = 'DECISION_PROTOCOL'; } }
export async function decisionTurn(app, params, options) {
  let result = await app.turn(params, options);
  for (let attempt = 0; ; attempt++) {
    try { validateDecision(JSON.parse(result.text)); return { ...result, timing: { ...result.timing, decisionRepairs: attempt } }; }
    catch (error) {
      if (!(error instanceof DecisionProtocolError) && !(error instanceof SyntaxError)) throw error;
      if (attempt === 1) throw new DecisionProtocolError('AI返回的任务决策仍不符合协议，尚未创建或推进任务');
      result = await app.turn({ ...params, input: [{ type:'text', text:
        '上一轮决策字段不兼容，请修正并重新返回完整JSON。源码检查与environmentQuery不能同时请求；确认业务实现逻辑应先创建analysis源码任务并选择原问题的sourceEnvironment，environmentQuery=null。需要实时环境数据时单独请求已配置范围，requiresSourceInspection=false。只修正决策，不执行工具、不扩大原意或权限；不确定先回复询问。所有管理员和环境审批仍由程序验证。' }] }, options);
    }
  }
}
export function conversationFailure(error) {
  if (error?.code === 'DECISION_PROTOCOL') return 'AI返回的任务安排有冲突，自动修正后仍未通过校验。本次没有创建或推进任务；这不是网络或登录错误，请维护者检查决策协议。';
  if (/timeout|timed out|超时/i.test(String(error?.message))) return '等待AI响应超时，本次没有创建或推进任务，请稍后重新 @ 发起。';
  return 'AI 调用失败，本次没有创建或推进任务。请维护者检查本机诊断记录，确认具体原因后重试；尚不能判断是网络还是登录问题。';
}
export function validateDecision(value) {
  try { return validateDecisionValue(value); }
  catch (error) { throw new DecisionProtocolError(error.message); }
}
function validateDecisionValue(value) {
  const actions = ['reply', 'create_task', 'clarify', 'approve', 'cancel', 'bind_project', 'approve_environment', 'request_environment_setup', 'approve_environment_setup', 'approve_environment_without_tls'];
  const intents = ['none', 'implementation', 'planning', 'analysis', 'verification', 'audit'];
  if (!value || !actions.includes(value.action) || !intents.includes(value.intent)) throw new Error('Unknown action or intent');
  for (const key of ['reply', 'instruction', 'jobId', 'projectId']) {
    if (typeof value[key] !== 'string' || value[key].length > 20000) throw new Error(`Invalid ${key}`);
  }
  if (!value.reply.trim()) throw new Error('Empty reply');
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.some((id) => typeof id !== 'string')) throw new Error('Invalid attachments');
  if (value.sourceEnvironment !== undefined && (typeof value.sourceEnvironment !== 'string' || value.sourceEnvironment.length > 100)) throw new Error('Invalid source environment');
  if (value.requiresSourceInspection !== undefined && typeof value.requiresSourceInspection !== 'boolean') throw new Error('Invalid source inspection decision');
  // Typed AI decision, not phrase matching. Legacy persisted decisions may omit it.
  if (value.environmentQuery != null && (value.action !== 'create_task' || value.intent !== 'analysis' || value.requiresSourceInspection === true)) throw new Error('Environment query must be a separate readonly request');
  if (value.action === 'approve_environment' && !value.jobId) throw new Error('Missing environment approval target');
  if (value.action === 'request_environment_setup' && (!value.environmentSetup || !value.instruction.trim() || value.intent !== 'analysis' || value.environmentQuery || value.requiresSourceInspection)) throw new Error('Invalid environment enrollment');
  if (value.environmentSetup && value.action !== 'request_environment_setup') throw new Error('Unexpected setup payload');
  if (value.requiresSourceInspection === true) {
    if (!['reply', 'create_task'].includes(value.action) || !['none', 'analysis'].includes(value.intent)
      || !value.instruction.trim()) throw new Error('Source inspection requires a standalone read-only analysis scope');
    value = { ...value, action: 'create_task', intent: 'analysis', jobId: '' };
  }
  if (value.action === 'create_task' && (!value.instruction.trim() || value.intent === 'none')) throw new Error('Missing task scope');
  if (['approve', 'cancel', 'clarify'].includes(value.action) && !value.jobId) throw new Error('Missing job ID');
  if (value.action === 'clarify' && !value.instruction.trim()) throw new Error('Empty clarification');
  return value;
}
