// Explicit live Codex semantic smoke. Never sends Feishu or applies a decision.
import assert from 'node:assert/strict';
import { CodexConversationEngine } from '../src/control-plane/codex-conversation.js';
import { ConversationService } from '../src/control-plane/conversations.js';

const old = { id: 'JOB-FICTIONAL', chatId: 'smoke', projectId: 'fictional', taskIntent: 'analysis',
  workflow: 'single_owner_intake', stage: 'owner_intake', status: 'awaiting_clarification',
  instruction: '调查登录接口', createdAt: '2026-09-05T10:00:00Z',
  result: { workspace: '/fictional/old-snapshot', finalMessage: '源码缺失，只有规范文档，业务仓不存在。' } };
const context = { config: {}, projects: { chatProjectMap: { smoke: 'fictional' },
  projects: { fictional: { displayName: '虚构演示项目', repoPath: '/fictional/projects/demo' } }, ownerOpenIds: [] },
  store: { read: async () => ({ jobs: [old], conversations: [{ id: 'prior', chatId: 'smoke', profile: 'owner',
    senderId: 'smoke', status: 'sent', content: '帮我看登录', response: old.result.finalMessage }] }) } };
const service = new ConversationService(context, { decide: async () => {} });
const engine = new CodexConversationEngine({ dataDir: new URL('../data/smoke/source-policy', import.meta.url).pathname });
const cases = [
  ['帮我查一下登录接口的调用链和鉴权逻辑，不修改代码。', true],
  ['那你能告诉我这个项目下有什么内容和文件吗', true],
  ['你好', false],
  ['解释一下你之前那份报告为什么说源码缺失，不用重新查文件', false],
];
try {
  for (const [message, inspect] of cases) {
    const input = await service.buildInput({ id: 'current', chatId: 'smoke', profile: 'owner', senderId: 'smoke',
      role: 'owner_intake', attachments: [], content: message });
    const result = await engine.decide(input, { sessionKey: 'source-policy-smoke' });
    console.log(JSON.stringify({ message, inspection: result.requiresSourceInspection, action: result.action,
      intent: result.intent, reply: result.reply, ms: result.timing.aiMs }));
    assert.equal(result.requiresSourceInspection, inspect);
    assert.equal(result.action, inspect ? 'create_task' : 'reply');
    if (inspect) { assert.equal(result.intent, 'analysis'); assert.ok(result.instruction.length > 10); }
  }
} finally { await engine.close(); }
