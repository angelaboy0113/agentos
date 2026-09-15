import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadStageInstruction } from '../runner/codex-executor.js';
import { CodexAppServer } from '../shared/codex-app-server.js';
import { codexEnvironment, conversationServerArgs, resolveCodexBinary } from '../shared/codex-runtime.js';

const schemaFile = fileURLToPath(new URL('../../config/conversation.schema.json', import.meta.url));
const instructionsFile = fileURLToPath(new URL('../../config/conversation.md', import.meta.url));

export class CodexConversationEngine {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new Map();
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
    const key = options.sessionKey ?? `${input.role}:${input.project?.id ?? ''}`;
    let session = this.sessions.get(key);
    const reused = Boolean(!input.memory?.enabled && session && session.generation === this.app.generation && session.count < 20);
    if (!reused) {
      if (session) this.releaseSession(key, session);
      if (this.sessions.size >= 24) {
        const idle = [...this.sessions].filter(([, item]) => !item.active).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (idle) this.releaseSession(...idle);
      }
      const role = await loadStageInstruction(input.role);
      const thread = await this.app.request('thread/start', {
        cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        developerInstructions: `${this.rules}\n角色职责（仅理解与决策，不能执行工具或角色任务）：\n${role}`,
      });
      session = { id: thread.thread.id, generation: this.app.generation, count: 0, touched: Date.now() };
      this.model = thread.model;
      this.sessions.set(key, session);
    }
    const preparedMs = Date.now() - began;
    session.active = true;
    try {
      const result = await this.app.turn({
        threadId: session.id, effort: 'low', approvalPolicy: 'never',
        input: [{ type: 'text', text: `本轮最新上下文（状态以此为准，历史里的操作不可重复执行）：\n${JSON.stringify(input)}` },
          ...(input.attachments ?? []).filter((item) => item.type === 'image').slice(-5).map((item) => ({ type: 'localImage', path: item.path }))],
        outputSchema: this.schema,
      }, { signal: options.signal, timeoutMs: this.options.timeoutMs ?? 90_000, onEvent: options.onEvent });
      session.count++;
      session.active = false;
      session.touched = Date.now();
      return { ...validateDecision(JSON.parse(result.text)), threadId: result.threadId,
        timing: { ...result.timing, preparedMs, aiMs: Date.now() - began, sessionReused: reused, model: this.model } };
    } catch (error) {
      // Discard uncertain read-only threads; never overlap a possibly active turn.
      this.releaseSession(key, session);
      throw error;
    }
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

export function validateDecision(value) {
  const actions = ['reply', 'create_task', 'clarify', 'approve', 'cancel', 'bind_project'];
  const intents = ['none', 'implementation', 'planning', 'analysis', 'verification', 'audit'];
  if (!value || !actions.includes(value.action) || !intents.includes(value.intent)) throw new Error('Unknown action or intent');
  for (const key of ['reply', 'instruction', 'jobId', 'projectId']) {
    if (typeof value[key] !== 'string' || value[key].length > 20000) throw new Error(`Invalid ${key}`);
  }
  if (!value.reply.trim()) throw new Error('Empty reply');
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.some((id) => typeof id !== 'string')) throw new Error('Invalid attachments');
  if (value.requiresSourceInspection !== undefined && typeof value.requiresSourceInspection !== 'boolean') throw new Error('Invalid source inspection decision');
  // Typed AI decision, not phrase matching. Legacy persisted decisions may omit it.
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
