// Explicit real-Codex check. No Feishu sends, Runner starts, or project mutations.
import { CodexConversationEngine } from '../src/control-plane/codex-conversation.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-real-ai-'));
const engine = new CodexConversationEngine({ dataDir: directory });
const input = {
  role: 'owner_intake', administrator: true,
  project: { id: 'fictional-demo', name: '虚构测试项目（无真实业务数据）' }, knownProjects: [],
  history: [], jobs: [], attachments: [], currentAttachmentIds: [], message: '你好，你是谁？你现在在哪个项目？',
};
try {
  const options = { onEvent: (type) => { if (['turn/started', 'turn/completed', 'error'].includes(type)) console.log(`Codex event: ${type}`); } };
  const first = await engine.decide(input, options);
  assert.equal(first.action, 'reply');
  assert.ok(first.threadId);
  console.log(JSON.stringify({ case: 'identity-and-project', action: first.action, reply: first.reply, timing: first.timing, realCodexThread: Boolean(first.threadId) }));
  input.history = [{ user: input.message, assistant: first.reply }];
  input.message = '那你能帮我做什么？先聊聊，不要创建任务';
  const warm = await engine.decide(input, options);
  assert.equal(warm.action, 'reply');
  assert.equal(warm.threadId, first.threadId);
  console.log(JSON.stringify({ case: 'warm-conversation', action: warm.action, timing: warm.timing }));
  input.history = [{ user: '虚构测试用例：示例登录接口返回500，我们先讨论，只修复登录，不改注册。', assistant: '范围明确：定位示例登录500并补回归测试，不动注册；等待你指示开始。' }];
  input.message = '就照刚才说的办吧';
  const second = await engine.decide(input, options);
  assert.equal(second.action, 'create_task');
  assert.equal(second.intent, 'implementation');
  assert.match(second.instruction, /登录/);
  assert.match(second.instruction, /注册/);
  console.log(JSON.stringify({ case: 'contextual-instruction', action: second.action, instruction: second.instruction, timing: second.timing, realCodexThread: Boolean(second.threadId) }));
} finally { await engine.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
