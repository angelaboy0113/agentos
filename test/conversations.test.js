import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createControlPlane, handleLarkCliEvent, notifyJobEvent } from '../src/control-plane/server.js';
import { validateDecision } from '../src/control-plane/codex-conversation.js';
import { conversationServerArgs } from '../src/shared/codex-runtime.js';
import { isForThisBot } from '../src/control-plane/lark-event-source.js';
import { routeDecision, sourceEvidence } from '../src/control-plane/conversations.js';

const decision = (fields = {}) => ({ reply: 'AI 的回答', action: 'reply', intent: 'none', instruction: '', jobId: '', projectId: '', attachmentIds: [], ...fields });
const message = (id, content, fields = {}) => ({
  type: 'im.message.receive_v1', message_id: id, content, chat_id: 'group', chat_type: 'group',
  sender_id: 'leader', sender_type: 'user', agent_role: 'owner_intake', agent_profile: 'owner',
  mentions: [{ id: 'bot-owner', key: '@_user_1', name: '项目负责人' }], ...fields,
});

async function setup(t, decide, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-ai-test-'));
  const replies = [], inputs = [];
  const app = await createControlPlane({
    dataDir: directory, storeFile: path.join(directory, 'store.json'),
    projectsFile: path.join(directory, 'projects.json'),
    adminToken: 'test-admin', runnerToken: 'test-runner',
    projects: {
      chatProjectMap: { group: 'demo', other: 'demo' }, projects: { demo: { displayName: '演示项目' } },
      ownerOpenIds: ['legacy-leader'], ownerOpenIdsByProfile: { owner: ['leader'] },
    },
    agents: { agents: { owner_intake: { profile: 'owner', openId: 'bot-owner' }, qa: { profile: 'qa', openId: 'bot-qa' }, developer: { profile: 'dev', openId: 'bot-dev' } } },
    feishuClient: { reply: async (id, text, options) => { replies.push({ id, text, options }); return { data: { message_id: `bot-reply-${replies.length}` } }; }, send: async (id, text) => replies.push({ id, text }) },
    conversationResponder: async (input) => { inputs.push(input); return decide(input); },
    ...overrides,
  });
  t.after(async () => { await app.conversations.stop(); await rm(directory, { recursive: true, force: true }); });
  const context = { ...app, feishu: overrides.feishuClient ?? app.conversations.context.feishu };
  const send = async (event) => { const result = await handleLarkCliEvent(context, event); await app.conversations.idle(); return result; };
  return { app, context, send, inputs, replies, directory };
}

test('all greetings and identity/project questions invoke AI, without jobs or phrase filters', async (t) => {
  const { send, app, inputs, replies } = await setup(t, (input) => decision({ reply: `真实 AI 回答：${input.message}` }));
  for (const [i, text] of ['你好', '你是谁？', '你在哪个项目下现在', '今天怎么样', '如果改一下会怎样？'].entries()) await send(message(`m${i}`, text));
  assert.equal(inputs.length, 5);
  assert.equal(replies.length, 5);
  assert.equal(inputs[2].project.name, '演示项目');
  assert.equal(inputs[4].history.length, 4);
  assert.equal((await app.store.read()).jobs.length, 0);
});

test('typed AI source inspection cannot end in a reply or escalate to writes', () => {
  const result = validateDecision(decision({ requiresSourceInspection: true, instruction: '只读核查当前目录里的接口逻辑' }));
  assert.equal(result.action, 'create_task');
  assert.equal(result.intent, 'analysis');
  assert.throws(() => validateDecision(decision({ requiresSourceInspection: true })), /standalone/);
  assert.throws(() => validateDecision(decision({ requiresSourceInspection: true, action: 'approve', instruction: '查源码' })), /read-only/);
  assert.throws(() => validateDecision(decision({ requiresSourceInspection: true, intent: 'implementation', instruction: '改源码' })), /read-only/);
  assert.equal(validateDecision(decision({ requiresSourceInspection: false })).action, 'reply');
});

test('old worktree evidence cannot represent current directory, even when directory names look alike', () => {
  const job = { taskIntent: 'analysis', workflow: 'analysis_review', result: { workspace: 'D:/projects/tpm-old' } };
  assert.equal(sourceEvidence(job, 'D:/projects/tpm').applicability, 'not_evidence_for_current_source_directory');
  job.result.workspace = 'd:\\projects\\tpm\\';
  assert.equal(sourceEvidence(job, 'D:/projects/tpm').applicability, 'historical_snapshot_not_current_check');
  job.workflow = 'single_owner_intake';
  assert.equal(sourceEvidence(job, 'D:/projects/tpm').applicability, 'not_evidence_for_current_source_directory');
});

test('new source request gets current project context and a developer task without mutating the old blocked job', async (t) => {
  const { send, app, inputs } = await setup(t, () => decision({ requiresSourceInspection: true, instruction: '只读查看项目目录及登录实现' }));
  app.projects.projects.demo.repoPath = 'D:/projects/tpm';
  const { job } = await app.store.createJob({ chatId: 'group', projectId: 'demo', stage: 'owner_intake',
    workflow: 'single_owner_intake', taskIntent: 'analysis', instruction: '旧接口调查', status: 'awaiting_clarification',
    result: { workspace: 'D:/old-worktree', finalMessage: 'SOURCE_MISSING_OLD' } });
  await app.store.transact((state) => { state.jobs.find((item) => item.id === job.id).result = {
    workspace: 'D:/old-worktree', finalMessage: 'SOURCE_MISSING_OLD' }; });
  await send(message('inspect-again', '那你看看现在里面具体都有些什么'));
  assert.equal(inputs[0].sourcePolicy.checkedNow, false);
  assert.equal(inputs[0].jobs.length,0);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /SOURCE_MISSING_OLD/);
  const state = await app.store.read();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[1].stage, 'developer');
  assert.equal(state.jobs[1].taskIntent, 'analysis');
  assert.equal((await app.store.getJob(job.id)).result.finalMessage, 'SOURCE_MISSING_OLD');
});

test('multi-turn reference and old screenshot produce one standalone instruction; delivery dedupes', async (t) => {
  const { send, app, inputs } = await setup(t, (input) => input.history.length ? decision({
    action: 'create_task', intent: 'implementation', reply: '我会按刚才范围安排。',
    instruction: '只修复登录接口 500；参考截图并添加回归测试，不改注册流程。', attachmentIds: ['image-1'],
  }) : decision({ reply: '先确认登录失败的影响范围。' }));
  await send(message('image-msg', '先讨论登录 500，不要修改', { attachments: [{ id: 'image-1', type: 'image', path: '/fake.png' }] }));
  const event = message('go-msg', '按刚才的改，开始吧');
  await send(event);
  const duplicate = await send(event);
  const state = await app.store.read();
  assert.equal(inputs.length, 2);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.jobs.length, 1);
  assert.match(state.jobs[0].instruction, /不改注册流程/);
  assert.equal(state.jobs[0].attachments[0].id, 'image-1');
  assert.equal(state.jobs[0].workflow, 'full_delivery');
});

test('context remains on disk and is restored after service reconstruction', async (t) => {
  const { send, app, directory } = await setup(t, () => decision({ reply: '已记下：只改登录，不改注册。' }));
  await send(message('first', '这次只改登录，不改注册'));
  await app.conversations.stop();
  let restored;
  const second = await createControlPlane({
    ...app.config, projects: app.projects, agents: app.agents,
    feishuClient: { reply: async () => ({}) },
    conversationResponder: async (input) => { restored = input; return decision(); },
    storeFile: path.join(directory, 'store.json'),
  });
  t.after(async () => { await second.conversations.stop(); });
  await second.conversations.enqueue(message('second', '还记得刚才的范围吗'));
  await second.conversations.idle();
  await second.conversations.stop();
  assert.equal(restored.history[0].user, '这次只改登录，不改注册');
});

test('reply without @ follows recorded bot message, other group messages and bots are ignored', async (t) => {
  const { send, inputs } = await setup(t, () => decision());
  await send(message('first', '你好'));
  await send(message('second', '你在哪个项目', { mentions: [], reply_to: 'bot-reply-1' }));
  const unrelated = await send(message('third', '普通群聊', { mentions: [] }));
  await send(message('fourth', '机器人回话', { sender_type: 'bot' }));
  await send(message('fifth', '@测试', { mentions: [{ id: 'bot-qa' }] }));
  assert.equal(inputs.length, 2);
  assert.equal(unrelated.ignored, true);
  assert.equal(isForThisBot(message('m', '', { mentions: [{ id: 'bot-qa' }] }), ''), false);
});

test('AI failure or invalid schema does not become a task or a template intent reply', async (t) => {
  const { send, app, replies } = await setup(t, () => { throw new Error('simulated unavailable'); });
  await send(message('broken', '帮我改一下登录'));
  assert.equal((await app.store.read()).jobs.length, 0);
  assert.match(replies[0].text, /AI 调用失败/);
  assert.throws(() => validateDecision(decision({ action: 'shell' })), /Unknown/);
  assert.throws(() => validateDecision(decision({ action: 'create_task' })), /Missing/);
});

test('natural approval invokes AI but cannot bypass admin, chat or status checks', async (t) => {
  let jobId;
  const { send, app, replies, inputs } = await setup(t, () => decision({ action: 'approve', jobId, reply: '我会核对并提交确认。' }));
  const { job } = await app.store.createJob({ chatId: 'group', projectId: 'demo', stage: 'owner_intake', workflow: 'full_delivery', instruction: '交付登录修复', status: 'awaiting_approval' });
  jobId = job.id;
  await send(message('deny', '结果看过了，接着做', { sender_id: 'not-admin' }));
  assert.match(replies.at(-1).text, /只有真人管理员/);
  assert.equal((await app.store.read()).jobs.length, 1);
  await send(message('cross', '放行这个', { chat_id: 'other' }));
  assert.match(replies.at(-1).text, /不能跨群/);
  await send(message('allow', '这个结果可以，交给下一位吧'));
  assert.equal((await app.store.read()).jobs.at(-1).stage, 'pm');
  await send(message('allow', '重复投递'));
  assert.equal((await app.store.read()).jobs.length, 2);
  assert.equal(inputs.length, 3);
});

test('analysis delegates read-only investigation; planning stays scoped; QA implementation goes to owner', () => {
  assert.deepEqual(routeDecision('owner_intake', 'analysis'), { stage: 'developer', workflow: 'analysis_review' });
  assert.deepEqual(routeDecision('pm', 'planning'), { stage: 'pm', workflow: 'single_pm' });
  assert.deepEqual(routeDecision('qa', 'implementation'), { stage: 'owner_intake', workflow: 'full_delivery' });
});

test('AI analysis creates a developer job with owner origin and refuses missing team profiles', async (t) => {
  const { send, app, replies, inputs } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '只读查登录接口' }));
  app.projects.projects.demo.repoPath = 'D:/demo';
  await send(message('analysis', '帮我看看登录接口怎么走'));
  const job = (await app.store.read()).jobs[0];
  assert.equal(job.agentProfile, 'dev');
  assert.equal(job.taskIntent, 'analysis');
  assert.equal(job.requestedAgentProfile, 'owner');
  assert.equal(job.delegation.toStage, 'developer');
  assert.equal(inputs[0].project.sourceDirectory, 'D:/demo');
  assert.match(replies[0].text, /开发只读调查 → 项目负责人汇总/);
  delete app.agents.agents.developer;
  await send(message('missing-dev', '再分析一次'));
  assert.equal((await app.store.read()).jobs.length, 1);
  assert.match(replies.at(-1).text, /需要配置开发和项目负责人/);
});

test('ordinary members may chat and investigate read-only source but cannot create executable work', async (t) => {
  let intent = 'implementation';
  const { send, app, replies } = await setup(t, () => decision({ action: 'create_task', intent,
    instruction: intent === 'analysis' ? '只读排查登录接口，不修改文件' : '修改登录接口并运行测试' }));
  for (const denied of ['implementation', 'planning', 'verification', 'audit']) {
    intent = denied;
    await send(message(`deny-${denied}`, '请开始执行', { sender_id: 'ordinary-member' }));
    assert.match(replies.at(-1).text, /只有真人管理员/);
  }
  assert.equal((await app.store.read()).jobs.length, 0);
  intent = 'analysis';
  await send(message('allow-analysis', '只读帮我排查登录接口', { sender_id: 'ordinary-member' }));
  const jobs = (await app.store.read()).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].taskIntent, 'analysis');
  assert.equal(jobs[0].senderId, 'ordinary-member');
});

test('ordinary task creator cannot resume an existing implementation job', async (t) => {
  let jobId;
  const { send, app, replies } = await setup(t, () => decision({ action: 'clarify', jobId, instruction: '继续修改登录接口' }));
  const { job } = await app.store.createJob({ chatId: 'group', projectId: 'demo', stage: 'developer', agentProfile: 'owner',
    originProfile: 'owner', senderId: 'ordinary-member', workflow: 'single_developer', taskIntent: 'implementation',
    instruction: '修改登录接口', status: 'awaiting_clarification' });
  jobId = job.id;
  await send(message('deny-implementation-clarify', '补充后继续执行', { sender_id: 'ordinary-member' }));
  assert.match(replies.at(-1).text, /只有真人管理员/);
  assert.equal((await app.store.getJob(job.id)).status, 'awaiting_clarification');
});

test('new result contract prevents failed QA/audit from awaiting approval and sends evidence', async (t) => {
  const { app, context, replies } = await setup(t, () => decision());
  const { job } = await app.store.createJob({ chatId: 'group', projectId: 'demo', stage: 'qa', workflow: 'qa_audit', instruction: '测试登录', status: 'running' });
  const result = await app.store.appendEvent(job.id, { type: 'completed', result: { outcome: 'blocked', finalMessage: '登录回归失败：POST /login 仍返回 500。' } });
  assert.equal(result.job.status, 'blocked');
  await assert.rejects(app.store.approve(job.id, 'leader'), /not awaiting approval/);
  await notifyJobEvent(context, result);
  assert.match(replies.at(-1).text, /POST \/login/);
  assert.match(replies.at(-1).text, /未通过/);
});

test('read-only AI process has explicit sandbox and does not conflict with automatic review', () => {
  const args = conversationServerArgs();
  assert.equal(args.includes('--approve-for-me'), false);
  assert.ok(args.includes('--stdio'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.equal(args.some((arg) => arg.startsWith('mcp_servers.node_repl')), false);
  assert.equal(args.includes('--model'), false);
});

test('outbox retry does not re-run AI or create another job', async (t) => {
  let count = 0;
  const { send, app, inputs } = await setup(t, () => decision({ action: 'create_task', intent: 'implementation', instruction: '修复登录' }), {
    feishuClient: { reply: async () => { if (++count === 1) throw new Error('network failure'); return {}; } },
  });
  await send(message('outbox', '改一下登录'));
  await app.store.transact((state) => { state.conversations[0].retryAt = null; });
  app.conversations.wake();
  await app.conversations.idle();
  const state = await app.store.read();
  assert.equal(state.conversations[0].status, 'sent');
  assert.equal(state.jobs.length, 1);
  assert.equal(inputs.length, 1);
});

test('different sessions run concurrently; same session preserves context and order', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const { app, inputs, replies } = await setup(t, async (input) => {
    if (input.message === 'slow') { started(); await blocked; }
    return decision({ reply: input.message });
  });
  t.after(() => release());
  await app.conversations.enqueue(message('slow', 'slow'));
  await firstStarted;
  await app.conversations.enqueue(message('next', 'next'));
  await app.conversations.enqueue(message('other', 'other', { sender_id: 'another-user' }));
  for (let i = 0; i < 100 && !replies.some((r) => r.text === 'other'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(replies.some((r) => r.text === 'other'));
  assert.equal(inputs.some((input) => input.message === 'next'), false);
  release();
  await app.conversations.idle();
  assert.equal(inputs.find((input) => input.message === 'next').history[0].user, 'slow');
  assert.deepEqual(replies.map((r) => r.text), ['other', 'slow', 'next']);
});

test('slow replies get one factual receipt and timing; final answer still comes from AI', async (t) => {
  const { send, app, replies } = await setup(t, async () => {
    await new Promise((r) => setTimeout(r, 100));
    return decision({ reply: '模型结果' });
  }, { conversationOptions: { feedbackMs: 10 } });
  await send(message('slow-feedback', '你好'));
  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /已收到/);
  assert.equal(replies[1].text, '模型结果');
  const turn = (await app.store.read()).conversations[0];
  assert.equal(turn.feedbackState, 'sent');
  assert.ok(turn.timing.aiMs >= 100);
  assert.ok(turn.timing.totalMs >= turn.timing.aiMs);
  await send(message('slow-feedback', '你好'));
  assert.equal(replies.length, 2);
});

test('delivery backoff blocks only its session, not other roles, and preserves same-session order', async (t) => {
  const { app, inputs } = await setup(t, () => decision(), { feishuClient: { reply: async (id) => {
    if (id === 'failed-send') throw new Error('delivery unavailable'); return {};
  } } });
  await app.conversations.enqueue(message('failed-send', 'first'));
  await app.conversations.idle();
  await app.conversations.enqueue(message('waits', 'second'));
  await app.conversations.enqueue(message('parallel', 'third', { agent_role: 'qa', agent_profile: 'qa' }));
  await app.conversations.idle();
  assert.deepEqual(inputs.map((input) => input.message), ['first', 'third']);
});

test('job progress is rate-limited and never forwards arbitrary log text', async (t) => {
  const { app, context, replies } = await setup(t, () => decision());
  const { job } = await app.store.createJob({ chatId: 'group', projectId: 'demo', stage: 'developer', workflow: 'dev_qa_audit', instruction: '示例', status: 'running' });
  await notifyJobEvent(context, { job, event: { type: 'progress', message: 'secret raw log' } });
  assert.equal(replies.length, 0);
  await notifyJobEvent(context, { job, event: { type: 'progress', phase: 'codex_working', elapsedSeconds: 30 } });
  await notifyJobEvent(context, { job, event: { type: 'progress', phase: 'codex_working', elapsedSeconds: 60 } });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /尚未完成/);
});

test('source environment is selected from local catalog, missing/unknown environment creates no job', async t => {
  let selected = '';
  const project = { displayName:'Demo', repoPath:'/project', analysisSourceMode:'isolated', analysisEnvironments:{uat:{description:'System UAT',repositories:[]},prd:{description:'Production',repositories:[]}} };
  const {send,app,inputs,replies} = await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'read code',sourceEnvironment:selected}),{
    projects:{chatProjectMap:{group:'demo'},projects:{demo:project},ownerOpenIdsByProfile:{owner:['leader']}},
  });
  await send(message('missing-env','查代码'));
  assert.equal((await app.store.read()).jobs.length,0);
  assert.equal(inputs[0].project.sourceEnvironments.length,2);
  assert.match(replies.at(-1).text,/明确/);
  selected='unconfigured'; await send(message('bad-env','查代码'));
  assert.equal((await app.store.read()).jobs.length,0);
  selected='uat'; await send(message('uat-env','查 UAT 代码'));
  assert.equal((await app.store.read()).jobs[0].sourceEnvironment,'uat');
  const evidence=sourceEvidence({taskIntent:'analysis',workflow:'analysis_review',result:{workspace:'/snapshots/a/workspace',sourceSync:{sourceRoot:'/project',environment:'uat',repositories:[{branch:'uat',commit:'abc'}]}}},'/project');
  assert.equal(evidence.applicability,'historical_snapshot_not_current_check');
  assert.equal(evidence.sourceEnvironment,'uat');
});

test('late mention edit accepts previously ignored message exactly once', async t => {
 const {send,app,inputs}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'只读查系统逻辑'}));
 await send(message('edited-source','initial question',{mentions:[]}));assert.equal(inputs.length,0);
 await send(message('edited-source','updated @owner question',{edited_mention:true}));
 await send(message('edited-source','another edit',{edited_mention:true}));
 assert.equal(inputs.length,1);assert.equal((await app.store.read()).jobs.length,1);
});
