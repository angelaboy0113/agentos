import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createControlPlane, notifyJobEvent } from '../src/control-plane/server.js';
import { publishQuestion, questionJob } from '../src/control-plane/questions.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { jobActionVersion } from '../src/control-plane/message-cards.js';
import { CodexConversationEngine } from '../src/control-plane/codex-conversation.js';
import { loadConversationSettings } from '../src/control-plane/conversation-settings.js';
const decision = (extra = {}) => ({ action: 'reply', intent: 'none', reply: '收到', instruction: '', projectId: '', jobId: '', attachmentIds: [], ...extra });
async function setup(t, decide = () => decision()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-questions-'));
  const calls = [], inputs = [];
  const feishu = {
    replyCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { message_id: `card-${calls.length}` }; },
    updateCard: async (id, card, options) => { calls.push({ type: 'patch', id, card, options }); },
    reply: async (id, text, options) => { calls.push({ type: 'mention', id, text, options }); return { message_id: 'notice' }; },
  };
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'state.json'),
    projectsFile: path.join(directory, 'projects.json'), conversationFile: path.join(directory, 'conversation.json'),
    projects: { chatProjectMap: { group: 'demo' }, projects: { demo: { displayName: 'Demo' } }, ownerOpenIdsByProfile: { owner: ['ou_admin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' }, pm: { profile: 'pm' } } },
    feishuClient: feishu, conversationOptions: { groupSessions: true, questionCards: true, feedbackMs: 0 },
    conversationResponder: async (input) => { inputs.push(input); return decide(input); } });
  const context = { ...app, feishu };
  const send = async (id, sender = 'ou_asker', extra = {}) => {
    await app.conversations.enqueue({ message_id: id, chat_id: 'group', sender_id: sender, chat_type: 'group',
      agent_profile: 'owner', agent_role: 'owner_intake', content: `question-${id}`, ...extra });
    await app.conversations.idle();
  };
  t.after(async () => { await app.conversations.stop(); await app.cards.stop(); await rm(directory, { recursive: true, force: true }); });
  return { app, context, send, calls, inputs, directory };
}
test('five senders have five durable question cards, shared intake context, current actor authority', async (t) => {
  const { app, send, calls, inputs } = await setup(t);
  await Promise.all(Array.from({ length: 5 }, (_, i) => send(`m${i}`, i ? `ou_person${i}` : 'ou_admin')));
  const state = await app.store.read();
  assert.equal(Object.keys(state.questions).length, 5);
  assert.equal(Object.keys(state.cardMessages).length, 5);
  assert.equal(calls.filter((c) => c.type === 'send').length, 5);
  assert.equal(new Set(calls.filter((c) => c.type === 'send').map((c) => c.id)).size, 5);
  assert.equal(inputs[0].administrator, true); assert.equal(inputs[1].administrator, false);
  assert.equal(inputs[4].history.length, 4); assert.equal(inputs[4].nativeSession, true);
  assert.equal(new Set(state.conversations.map((c) => app.conversations.key(c))).size, 1);
});
test('question card stays owned by intake bot across developer/report, mentions only final original asker', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '只读检查' }));
  await send('m');
  let state = await app.store.read(); const job = state.jobs[0], qid = job.questionId;
  assert.ok(qid); assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
  await notifyJobEvent(context, { job, event: { type: 'started' } });
  await app.store.transact((s) => {
    const first = s.jobs[0]; first.status = 'completed'; first.nextJobId = 'JOB-report';
    s.jobs.push({ ...structuredClone(first), id: 'JOB-report', nextJobId: null, stage: 'owner_report', agentProfile: 'owner', status: 'running' });
  });
  await notifyJobEvent(context, { job, event: { type: 'completed' } });
  assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
  assert.match(JSON.stringify(calls.at(-1).card), /项目负责人.*执行中/);
  await app.store.transact((s) => { s.jobs[1].status = 'completed'; s.jobs[1].result = { finalMessage: '完整结论' }; });
  await notifyJobEvent(context, { job, event: { type: 'progress', phase: 'tool_activity' } });
  await publishQuestion(context, qid);
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 1);
  assert.ok(calls.every((c) => c.options.profile === 'owner'));
  assert.match(calls.find((c) => c.type === 'mention').text, /ou_asker/);
  assert.equal((await app.store.read()).cardMessages[`question:${qid}`].terminal, true);
});
test('completed answer survives followup; new card retains parent association', async (t) => {
  const { app, send, calls } = await setup(t);
  await send('m'); const s = await app.store.read(), key = Object.keys(s.cardMessages)[0], card = s.cardMessages[key];
  await send('follow', 'ou_asker', { reply_to: card.messageId });
  let state = await app.store.read(); assert.equal(Object.keys(state.questions).length, 2);
  assert.equal(state.cardMessages[key].messageId, card.messageId);
  assert.deepEqual(state.cardMessages[key].card, card.card);
  assert.equal(state.questions[state.conversations[1].questionId].parentQuestionId, state.conversations[0].questionId);
  assert.equal(state.cardMessages[key].generation, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 2);
  assert.equal(new Set(calls.filter((c) => c.type === 'mention').map((c) => c.options.idempotencyKey)).size, 2);
  await send('stranger', 'ou_other', { reply_to: card.messageId });
  await send('new', 'ou_asker');
  assert.equal(Object.keys((await app.store.read()).questions).length, 4);
  await app.cards.upsert(key, card.card, card.destination, { generation: 1, terminal: true, immediate: true });
  assert.equal((await app.store.read()).cardMessages[key].generation, 1);
});
test('a followup cannot duplicate a running question task or borrow administrator authority', async (t) => {
  const { app, send } = await setup(t, (input) => decision({ action: 'create_task', intent: input.message.includes('write') ? 'implementation' : 'analysis', instruction: '检查' }));
  await send('m'); let state = await app.store.read(); const card = Object.values(state.cardMessages)[0];
  await send('follow', 'ou_asker', { reply_to: card.messageId });
  assert.equal((await app.store.read()).jobs.length, 1);
  await send('write', 'ou_person');
  state = await app.store.read(); assert.equal(state.jobs.length, 1); assert.match(state.conversations.at(-1).actionError, /管理员/);
});
test('question callback resolves current stage on original bot; creator can cancel analysis, stranger cannot', async (t) => {
  const { app, context, send } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); const state = await app.store.read(), job = state.jobs[0], card = Object.values(state.cardMessages)[0];
  const event = { type: 'card.action.trigger', event_id: 'denied', operator_id: 'ou_other', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: { action: 'cancel', version: jobActionVersion(job) } };
  assert.equal((await handleCardAction(context, event)).ok, false);
  assert.equal((await app.store.getJob(job.id)).status, 'queued');
  assert.equal((await handleCardAction(context, { ...event, event_id: 'accepted', operator_id: 'ou_asker' })).ok, true);
  assert.equal((await app.store.getJob(job.id)).status, 'cancelled');
  assert.equal(Object.keys((await app.store.read()).cardMessages).length, 1);
});
test('old question-stage button cannot operate a successor with same empty event history', async (t) => {
  const { app, context, send } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); const state = await app.store.read(), job = state.jobs[0], card = Object.values(state.cardMessages)[0];
  await app.store.transact((s) => { s.jobs[0].status = 'completed'; s.jobs[0].nextJobId = 'NEXT'; s.jobs.push({ ...s.jobs[0], id: 'NEXT', nextJobId: null, status: 'queued', stage: 'owner_report', agentProfile: 'owner' }); });
  await publishQuestion(context, job.questionId);
  const result = await handleCardAction(context, { type: 'card.action.trigger', event_id: 'old', operator_id: 'ou_admin', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: { action: 'cancel', version: jobActionVersion(job) } });
  assert.equal(result.ok, false); assert.equal((await app.store.getJob('NEXT')).status, 'queued');
});
test('persistent session resumes across engine restart, caches decisions, and keeps private registry', async (t) => {
  const { directory } = await setup(t); const calls = [];
  function engine() {
    const e = new CodexConversationEngine({ dataDir: directory }); e.cwd = directory; e.rules = 'rules'; e.schema = {};
    e.start = async () => {}; e.app = { generation: 1, start: async () => {}, close: async () => {},
      request: async (name, args) => { calls.push({ name, args }); return { thread: { id: args.threadId ?? 'persistent-id' } }; },
      turn: async (args) => { calls.push({ name: 'turn', args }); return { text: JSON.stringify(decision()), timing: {} }; } };
    return e;
  }
  const input = { nativeSession: true, requestId: 'one', role: 'owner_intake', history: [{ user: 'bootstrap' }], attachments: [] };
  const first = engine(); await first.decide(input, { sessionKey: 'group-a' }); await first.close();
  const second = engine(); await second.decide(input, { sessionKey: 'group-a' });
  assert.equal(calls.filter((c) => c.name === 'turn').length, 1);
  await second.decide({ ...input, requestId: 'two' }, { sessionKey: 'group-a' }); await second.close();
  assert.equal(calls.filter((c) => c.name === 'thread/start').length, 1);
  assert.equal(calls.filter((c) => c.name === 'thread/resume').length, 1);
  assert.equal(calls.find((c) => c.name === 'thread/start').args.ephemeral, false);
  assert.match(calls.filter((c) => c.name === 'turn')[1].args.input[0].text, /"history":\[\]/);
  assert.equal((await stat(path.join(directory, 'codex-conversations.json'))).mode & 0o777, 0o600);
});
test('invalid opt-in settings or corrupt registry fail closed without overwriting saved sessions', async (t) => {
  const { directory } = await setup(t); const f = path.join(directory, 'settings.json');
  assert.deepEqual(await loadConversationSettings(f), { groupSessions: false, questionCards: false });
  await writeFile(f, JSON.stringify({ groupSessions: 'yes', questionCards: true }));
  await assert.rejects(loadConversationSettings(f));
  const e = new CodexConversationEngine({ dataDir: directory });
  await writeFile(e.registry.file, '{broken');
  await assert.rejects(e.registry.set('x', {}));
});
test('question clarification reopens same card and owner-profile approval creates one successor', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'implementation', instruction: '实施' }));
  await send('m', 'ou_admin'); let s = await app.store.read(); const first = s.jobs[0], key = `question:${first.questionId}`;
  await app.store.transact((state) => { state.jobs[0].status = 'awaiting_clarification'; });
  await publishQuestion(context, first.questionId);
  s = await app.store.read(); const job = s.jobs[0], card = s.cardMessages[key];
  const callback = { type: 'card.action.trigger', event_id: 'clarify', operator_id: 'ou_admin', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card),
    action_name: `clarify_${jobActionVersion(job)}`, form_value: { clarification: '确认范围' } };
  assert.equal((await handleCardAction(context, callback)).ok, true);
  s = await app.store.read(); assert.equal(s.jobs[0].status, 'queued'); assert.equal(s.cardMessages[key].terminal, false);
  await app.store.transact((state) => { state.jobs[0].status = 'awaiting_approval'; state.jobs[0].result = { finalMessage: '规划结果', outcome: 'ready' }; });
  await publishQuestion(context, first.questionId); s = await app.store.read();
  const approve = { ...callback, event_id: 'approve', action_name: '', action_value: { action: 'approve', version: jobActionVersion(s.jobs[0]) }, card_content: JSON.stringify(s.cardMessages[key].card) };
  assert.equal((await handleCardAction(context, approve)).ok, true);
  s = await app.store.read(); assert.equal(s.jobs.length, 2); assert.equal(s.jobs[1].questionId, first.questionId);
  assert.equal(s.cardMessages[key].terminal, false); assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
});
test('question pagination is display-only and source-sync blocking mentions asker and administrator once', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); let state = await app.store.read(); const job = state.jobs[0];
  await app.store.transact((s) => { s.jobs[0].status = 'blocked'; s.jobs[0].result = { sourceSyncBlocked: true, finalMessage: '需要解决仓库冲突。\n'.repeat(800) }; });
  await publishQuestion(context, job.questionId); state = await app.store.read(); const card = Object.values(state.cardMessages)[0];
  const find = (node) => { if (!node || typeof node !== 'object') return null; if (node.value?.action === 'result_page' && node.value.page === 1) return node.value; for (const v of Object.values(node)) { const x = find(v); if (x) return x; } return null; };
  const value = find(card.card); assert.ok(value);
  const result = await handleCardAction(context, { type: 'card.action.trigger', event_id: 'page', operator_id: 'ou_asker', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: value });
  assert.equal(result.ok, true); assert.deepEqual((await app.store.read()).jobs, state.jobs);
  const mentions = calls.filter((c) => c.type === 'mention'); assert.equal(mentions.length, 1);
  assert.match(mentions[0].text, /ou_asker/); assert.match(mentions[0].text, /ou_admin/);
});
test('persistent pending turn starts fresh and a resume transport error does not silently fork', async (t) => {
  const { directory } = await setup(t); const e = new CodexConversationEngine({ dataDir: directory });
  e.start = async () => {}; e.rules = 'rules'; e.cwd = directory; e.schema = {};
  const calls = [];
  e.app = { generation: 1, start: async () => {}, request: async (name) => { calls.push(name); if (name === 'thread/resume') throw new Error('transport'); return { thread: { id: 'new' } }; },
    turn: async () => ({ text: JSON.stringify(decision()), timing: {} }) };
  await e.registry.set('g', { threadId: 'uncertain', pending: 'previous' });
  const input = { nativeSession: true, requestId: 'now', role: 'owner_intake', attachments: [], history: [] };
  await e.decide(input, { sessionKey: 'g' }); assert.ok(calls.includes('thread/start')); assert.ok(!calls.includes('thread/resume'));
  e.sessions.clear(); calls.length = 0;
  await assert.rejects(e.decide({ ...input, requestId: 'later' }, { sessionKey: 'g' }), /transport/);
  assert.deepEqual(calls, ['thread/resume']);
});
