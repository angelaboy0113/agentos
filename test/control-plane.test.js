import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlPlane } from '../src/control-plane/server.js';
import { parseFeishuMessage } from '../src/control-plane/feishu.js';
import { routeInstruction, routeInstructionForStage } from '../src/shared/protocol.js';
import { buildCodexArgs } from '../src/runner/codex-executor.js';

test('Codex runner uses automatic review without a conflicting sandbox flag', () => {
  const args = buildCodexArgs('D:\\workspace', []);
  assert.equal(args.includes('--approve-for-me'), true);
  assert.equal(args.includes('--sandbox'), false);
  assert.deepEqual(args.slice(-2), ['--json', '-']);
});

test('only explicit role commands are recognized for execution', () => {
  assert.equal(routeInstruction('大家下午好').matched, false);
  assert.equal(routeInstruction('开发：修复登录接口').matched, true);
  assert.equal(routeInstruction('@开发 根据截图修复').stage, 'developer');
});

test('a dedicated bot identity routes plain text to its assigned stage', () => {
  const routed = routeInstructionForStage('修一下登录接口报错', 'developer');
  assert.equal(routed.matched, true);
  assert.equal(routed.stage, 'developer');
  assert.equal(routed.workflow, 'developer_delivery');
  assert.equal(routed.instruction, '修一下登录接口报错');
});

test('a greeting to a dedicated bot replies without creating a job', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-greeting-'));
  const replies = [];
  const app = await createControlPlane({
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin', runnerToken: 'runner',
    projects: { chatProjectMap: { oc_test: 'demo' }, projects: { demo: { displayName: 'Demo' } } },
    conversationResponder: async () => decision({ reply: '你好，我是项目负责人。' }),
    agents: { agents: { owner_intake: { profile: 'agentos-owner' } } },
    feishuClient: { reply: async (...args) => replies.push(args), send: async () => {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await app.conversations.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await request(base, '/api/v1/events/lark-cli', 'admin', {
    type: 'im.message.receive_v1', message_id: 'om_hello', chat_id: 'oc_test', sender_id: 'ou_leader',
    agent_role: 'owner_intake', agent_profile: 'agentos-owner', content: '你好', attachments: [],
  });
  assert.equal(response.body.conversation, true);
  await app.conversations.idle();
  assert.equal((await app.store.read()).jobs.length, 0);
  assert.equal(replies[0][1], '你好，我是项目负责人。');
});

test('QA and audit delegate implementation commands to the owner workflow', () => {
  const qa = routeInstructionForStage('修一下登录接口报错', 'qa');
  assert.equal(qa.stage, 'owner_intake');
  assert.equal(qa.workflow, 'full_delivery');
  assert.equal(qa.delegated, true);
  assert.equal(qa.requestedStage, 'qa');

  const audit = routeInstructionForStage('请直接修改代码并提交', 'owner_audit');
  assert.equal(audit.stage, 'owner_intake');
  assert.equal(audit.workflow, 'full_delivery');
  assert.equal(audit.delegated, true);

  const verification = routeInstructionForStage('验证登录接口修复结果', 'qa');
  assert.equal(verification.stage, 'qa');
  assert.equal(verification.workflow, 'qa_audit');
  assert.equal(verification.delegated, false);

  const legacyQa = routeInstruction('测试：修改登录接口代码');
  assert.equal(legacyQa.stage, 'owner_intake');
  assert.equal(legacyQa.delegated, true);
});

test('a QA bot code command creates an owner job and preserves the original role', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-delegation-'));
  const replies = [];
  const feishuClient = {
    reply: async (messageId, text, options) => replies.push({ messageId, text, options }),
    send: async (chatId, text, options) => replies.push({ chatId, text, options }),
    downloadMessageResource: async () => null,
  };
  const app = await createControlPlane({
    host: '127.0.0.1', port: 0,
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin-test', runnerToken: 'runner-test',
    projects: {
      ownerOpenIds: ['ou_leader'],
      chatProjectMap: { oc_test: 'demo' },
      projects: { demo: { displayName: 'Demo', repoPath: directory, baseBranch: 'main' } },
    },
    agents: {
      agents: {
        qa: { profile: 'agentos-qa' },
        owner_intake: { profile: 'agentos-owner' },
      },
    },
    feishuClient,
    conversationResponder: async () => decision({ action: 'create_task', intent: 'implementation', instruction: '修复登录接口报错', reply: '我会交给负责人协调。' }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await request(base, '/api/v1/events/lark-cli', 'admin-test', {
    type: 'im.message.receive_v1', message_id: 'om_delegate', chat_id: 'oc_test', sender_id: 'ou_leader',
    agent_role: 'qa', agent_profile: 'agentos-qa', content: '修一下登录接口报错', attachments: [],
  });

  assert.equal(created.status, 201);
  await app.conversations.idle();
  created.body.job = (await app.store.read()).jobs[0];
  assert.equal(created.body.job.stage, 'owner_intake');
  assert.equal(created.body.job.agentRole, 'owner_intake');
  assert.equal(created.body.job.agentProfile, 'agentos-owner');
  assert.equal(created.body.job.requestedAgentRole, 'qa');
  assert.equal(created.body.job.requestedAgentProfile, 'agentos-qa');
  assert.equal(created.body.job.delegation.fromStage, 'qa');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].options.profile, 'agentos-qa');

});

test('message -> lease -> complete -> approve -> QA job', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-'));
  const feishuClient = { enabled: false, reply: async () => {}, downloadMessageResource: async () => null };
  const app = await createControlPlane({
    host: '127.0.0.1',
    port: 0,
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin-test',
    runnerToken: 'runner-test',
    projects: {
      chatProjectMap: { oc_test: 'demo' },
      projects: { demo: { displayName: 'Demo', repoPath: directory, baseBranch: 'main' } },
    },
    feishuClient,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const first = await request(base, '/api/v1/dev/messages', 'admin-test', {
    messageId: 'om_001', chatId: 'oc_test', text: '开发：修复登录接口报错',
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.job.stage, 'developer');
  assert.equal(first.body.job.instruction, '修复登录接口报错');

  const duplicate = await request(base, '/api/v1/dev/messages', 'admin-test', {
    messageId: 'om_001', chatId: 'oc_test', text: '开发：修复登录接口报错',
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.job.id, first.body.job.id);

  const leased = await request(base, '/api/v1/jobs/lease', 'runner-test', {
    runnerId: 'runner-test-01', capabilities: ['developer'],
  });
  assert.equal(leased.body.job.id, first.body.job.id);
  assert.equal(leased.body.job.status, 'running');

  const completed = await request(base, `/api/v1/jobs/${first.body.job.id}/events`, 'runner-test', {
    runnerId: 'runner-test-01', leaseId: leased.body.job.lease.id,
    type: 'completed', result: { finalMessage: 'fixed', tests: ['unit'] },
  });
  assert.equal(completed.body.job.status, 'awaiting_approval');

  const approved = await request(base, `/api/v1/jobs/${first.body.job.id}/approve`, 'admin-test', {
    approverId: 'leader-01',
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.nextJob.stage, 'qa');
  assert.equal(approved.body.nextJob.agentRole, 'qa');
  assert.equal(approved.body.nextJob.status, 'queued');
  assert.equal(approved.body.nextJob.context[0].result.finalMessage, 'fixed');
});

test('owner intake can pause for clarification and resume the same job', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-clarification-'));
  const app = await createControlPlane({
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin', runnerToken: 'runner',
    projects: { chatProjectMap: { oc_test: 'demo' }, projects: { demo: { displayName: 'Demo' } } },
    feishuClient: { reply: async () => {}, send: async () => {} },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = await app.store.createJob({
    projectId: 'demo', projectName: 'Demo', chatId: 'oc_test', senderId: 'ou_leader',
    workflow: 'full_delivery', stage: 'owner_intake', instruction: '处理登录问题', status: 'running',
  });
  const completed = await app.store.appendEvent(created.job.id, {
    type: 'completed', result: { finalMessage: '[NEEDS_CLARIFICATION]\n缺少复现信息' },
  });
  assert.equal(completed.job.status, 'awaiting_clarification');
  const resumed = await app.store.resumeClarification(created.job.id, {
    senderId: 'ou_leader', sourceMessageId: 'om_more', instruction: '登录接口返回 500，期望正常登录',
  });
  assert.equal(resumed.status, 'queued');
  assert.match(resumed.instruction, /用户补充信息/);
  assert.equal(resumed.context.length, 1);
});

test('profile-scoped project administrator can approve through the owner bot', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-profile-owner-'));
  const replies = [];
  const app = await createControlPlane({
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin', runnerToken: 'runner',
    projects: {
      ownerOpenIds: ['ou_other_app'],
      ownerOpenIdsByProfile: { 'agentos-owner': ['ou_owner_app'] },
      chatProjectMap: { oc_test: 'demo' },
      projects: { demo: { displayName: 'Demo' } },
    },
    conversationResponder: async (input) => decision({ action: 'approve', jobId: input.jobs[0].id, reply: '我将提交本次确认。' }),
    agents: { agents: { owner_intake: { profile: 'agentos-owner' }, pm: { profile: 'agentos-pm' } } },
    feishuClient: { reply: async (...args) => replies.push(args), send: async (...args) => replies.push(args) },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const job = await app.store.createJob({
    projectId: 'demo', projectName: 'Demo', chatId: 'oc_test', workflow: 'full_delivery',
    stage: 'owner_intake', instruction: '明确任务', status: 'running',
  });
  await app.store.appendEvent(job.job.id, { type: 'completed', result: { finalMessage: '[READY]\n可以进入 PM' } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await request(base, '/api/v1/events/lark-cli', 'admin', {
    type: 'im.message.receive_v1', message_id: 'om_approve', chat_id: 'oc_test', sender_id: 'ou_owner_app',
    agent_role: 'owner_intake', agent_profile: 'agentos-owner', content: `确认 ${job.job.id}`, attachments: [],
  });
  await app.conversations.idle();
  assert.equal((await app.store.read()).jobs.at(-1).stage, 'pm');
});

test('an approved audit hands the mission back to the owner for the final report', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-owner-report-'));
  const app = await createControlPlane({
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin', runnerToken: 'runner',
    projects: { chatProjectMap: { oc_test: 'demo' }, projects: { demo: { displayName: 'Demo' } } },
    agents: { agents: { owner_intake: { profile: 'agentos-owner' } } },
    feishuClient: { reply: async () => {}, downloadMessageResource: async () => null },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = await app.store.createJob({
    projectId: 'demo', projectName: 'Demo', chatId: 'oc_test', workflow: 'owner_audit',
    stage: 'owner_audit', instruction: '审计候选结果', status: 'running',
  });
  await app.store.appendEvent(audit.job.id, { type: 'completed', result: { decision: 'pass' } });
  const approved = await app.store.approve(audit.job.id, 'leader', {
    agentRole: 'owner_report', agentProfile: 'agentos-owner',
  });
  assert.equal(approved.nextJob.stage, 'owner_report');
  assert.equal(approved.nextJob.agentProfile, 'agentos-owner');
  assert.equal(approved.nextJob.context.at(-1).result.decision, 'pass');
});

test('Feishu post parser extracts text, mention and image resources', () => {
  const parsed = parseFeishuMessage({
    message_type: 'post',
    mentions: [{ key: '@_user_1' }],
    content: JSON.stringify({
      zh_cn: {
        title: '登录问题',
        content: [[
          { tag: 'at', user_id: 'ou_bot', user_name: 'AgentOS' },
          { tag: 'text', text: '@_user_1 开发：按截图修复' },
          { tag: 'img', image_key: 'img_001' },
        ]],
      },
    }),
  });
  assert.equal(parsed.text, '登录问题 开发：按截图修复');
  assert.deepEqual(parsed.resources, [{ key: 'img_001', type: 'image' }]);
});

test('an image-only draft can be activated by replying with an instruction', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-image-'));
  const downloaded = [];
  const feishuClient = {
    enabled: true,
    reply: async () => {},
    downloadMessageResource: async (jobId, messageId, resourceKey) => {
      const attachment = { id: 'ATT-001', type: 'image', contentType: 'image/png', path: path.join(directory, 'fake.png') };
      downloaded.push({ jobId, messageId, resourceKey });
      return attachment;
    },
  };
  const app = await createControlPlane({
    dataDir: directory,
    storeFile: path.join(directory, 'store.json'),
    adminToken: 'admin', runnerToken: 'runner',
    projects: { chatProjectMap: { oc_test: 'demo' }, projects: { demo: { displayName: 'Demo' } } },
    feishuClient,
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const draft = await app.store.createJob({
    projectId: 'demo', projectName: 'Demo', chatId: 'oc_test', sourceMessageId: 'om_image',
    workflow: 'full_delivery', stage: 'owner_intake', instruction: '', status: 'awaiting_instruction',
    attachments: [{ id: 'ATT-001', type: 'image', contentType: 'image/png', path: path.join(directory, 'fake.png') }],
  });
  const routed = await app.store.activateDraft('om_image', {
    sourceMessageId: 'om_text', replyToMessageId: 'om_text', workflow: 'developer_delivery',
    stage: 'developer', instruction: '根据截图修复登录报错',
  });
  assert.equal(routed.id, draft.job.id);
  assert.equal(routed.status, 'queued');
  assert.equal(routed.attachments.length, 1);
  assert.equal(routed.instruction, '根据截图修复登录报错');
});

async function request(base, route, token, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function decision(fields = {}) {
  return { action: 'reply', intent: 'none', reply: '已了解。', instruction: '', jobId: '', projectId: '', attachmentIds: [], ...fields };
}
