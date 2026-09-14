import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/shared/store.js';
import { ExecutionActivity, commandLabel } from '../src/shared/execution-activity.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { conversationCard, jobCard, publicText, resultParts } from '../src/control-plane/message-cards.js';
import { createControlPlane, handleLarkCliEvent, notifyJobEvent } from '../src/control-plane/server.js';

const destination = { replyTo: 'om_question', profile: 'owner' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-cards-test-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const calls = [];
  const client = {
    replyCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { ok: true, data: { message_id: 'om_card' } }; },
    sendCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { data: { message_id: 'om_job_card' } }; },
    updateCard: async (id, card, options) => { calls.push({ type: 'patch', id, card, options }); return { ok: true }; },
    reply: async (id, text) => { calls.push({ type: 'text', id, text }); return { data: { message_id: 'om_more' } }; }, ...overrides,
  };
  const cards = new LiveCards(store, client, { intervalMs: 0 });
  t.after(async () => { await cards.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, client, calls, cards };
}
const chat = (fields = {}) => ({ id: 'chat1', role: 'owner_intake', status: 'thinking', createdAt: new Date().toISOString(), ...fields });

test('only real tool events count once; no reasoning, outputs or arguments are exposed', () => {
  const activity = new ExecutionActivity();
  assert.equal(activity.accept({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'PRIVATE' } }), null);
  const item = { id: 'c', type: 'command_execution', command: 'curl -H "Authorization: Bearer supersecret" https://private', aggregated_output: 'PRIVATE' };
  assert.equal(activity.accept({ type: 'item.started', item }).total, 1);
  assert.equal(activity.accept({ type: 'item.started', item }).total, 1);
  const result = activity.accept({ type: 'item.completed', item: { ...item, exit_code: 1 } });
  assert.equal(result.completed, 1); assert.equal(result.recent[0].failed, true);
  assert.equal(activity.accept({ type: 'item.completed', item }), null);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|PRIVATE|private|curl/);
  assert.equal(commandLabel('git diff --stat'), 'git diff --stat');
  assert.notEqual(commandLabel('git diff --stat; echo secret'), 'git diff --stat; echo secret');
});

test('cards have responsive groups, semantic failure and bounded details without a fake stop button', () => {
  const job = { id: 'job', stage: 'developer', projectName: 'demo', status: 'failed', events: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { error: 'supersecret' } };
  const card = jobCard(job);
  assert.equal(card.schema, '2.0'); assert.equal(card.config.update_multi, true);
  assert.equal(card.header.template, 'red'); assert.ok(card.body.elements.length <= 5);
  assert.doesNotMatch(JSON.stringify(card), /停止任务|supersecret|stretch/);
  const text = '中文<&😀'.repeat(4000);
  const parts = resultParts(text);
  assert.equal(parts.primary + parts.overflow, publicText(text));
  assert.ok(Buffer.byteLength(JSON.stringify(conversationCard(chat({ status: 'ready', response: text })))) < 28_000);
  assert.doesNotMatch(publicText('api_key="secret-value" Authorization=Bearer-TOKEN <at id=all></at>'), /secret-value|Bearer-TOKEN|<at/);
});

test('receipt and result update ONE message with a stable sender; terminal cannot regress', async (t) => {
  const { cards, calls, store } = await setup(t);
  await cards.upsert('chat:1', conversationCard(chat()), destination, { immediate: true });
  await cards.upsert('chat:1', conversationCard(chat({ status: 'ready', response: '你好，真实结果' })), destination, { immediate: true, terminal: true });
  await cards.upsert('chat:1', conversationCard(chat()), destination, { immediate: true });
  assert.deepEqual(calls.map((c) => c.type), ['send', 'patch']);
  assert.equal(calls[1].id, 'om_card'); assert.equal(calls[1].options.profile, 'owner');
  assert.equal((await store.read()).cardMessages['chat:1'].terminal, true);
  await assert.rejects(cards.upsert('chat:1', conversationCard(chat()), { ...destination, profile: 'qa' }, { terminal: true }), /identity/);
});

test('in-flight progress coalesces, then terminal wins without concurrent PATCH calls', async (t) => {
  const gate = deferred(), entered = deferred(); let concurrent = 0, max = 0;
  const patches = [];
  const { cards } = await setup(t, { updateCard: async (id, card) => {
    concurrent++; max = Math.max(max, concurrent); patches.push(card.header.title.content);
    if (patches.length === 1) { entered.resolve(); await gate.promise; } concurrent--;
  } });
  await cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  const running = cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  await entered.promise;
  const final = cards.upsert('x', conversationCard(chat({ status: 'ready', response: '完成' })), destination, { terminal: true, immediate: true });
  gate.resolve(); await Promise.all([running, final]);
  assert.equal(max, 1); assert.match(patches.at(-1), /已回复/);
});

test('failed card update survives reconstruction; legacy overflow is never sent', async (t) => {
  let fail = true;
  const { cards, store, client, calls } = await setup(t, { updateCard: async () => { if (fail) throw new Error('offline'); } });
  await cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  await assert.rejects(cards.upsert('x', conversationCard(chat({ status: 'ready', response: '完成' })), destination,
    { immediate: true, terminal: true, resultText: '完整详情'.repeat(1000) }), /offline/);
  assert.equal((await store.read()).cardMessages.x.messageId, 'om_card');
  await store.transact((state) => { state.cardMessages.x.overflow = ['旧版待发续文']; });
  fail = false;
  const restored = new LiveCards(store, client, { intervalMs: 0 });
  await restored.flush('x', true); await restored.stop();
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'text').length, 0);
  assert.ok((await store.read()).cardMessages.x.detailPages.length > 1);
});

test('uncertain initial send retries the same idempotency key', async (t) => {
  const keys = []; let fail = true;
  const { cards } = await setup(t, { replyCard: async (id, card, options) => {
    keys.push(options.idempotencyKey); if (fail) throw new Error('timeout'); return { message_id: 'om_existing' };
  } });
  await assert.rejects(cards.upsert('x', conversationCard(chat()), destination, { immediate: true }));
  fail = false; await cards.flush('x', true);
  assert.equal(keys[0], keys[1]);
});

test('full conversation path updates receipt, preserves AI output and accepts reply to the card', async (t) => {
  const { directory, client, calls } = await setup(t);
  let aiCalls = 0;
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'app.json'),
    projects: { projects: { demo: { displayName: 'demo' } }, chatProjectMap: { group: 'demo' } },
    agents: { agents: { owner_intake: { profile: 'owner', openId: 'bot' } } }, feishuClient: client,
    conversationOptions: { feedbackMs: 5 }, conversationResponder: async () => {
      aiCalls++; await pause(50); return { reply: 'AI 的真实回答', action: 'reply', intent: 'none', instruction: '', jobId: '', projectId: '', attachmentIds: [] };
    } });
  t.after(async () => { await app.conversations.stop(); await app.cards.stop(); });
  const event = { type: 'im.message.receive_v1', message_id: 'm1', chat_id: 'group', sender_id: 'human', chat_type: 'group', sender_type: 'user',
    agent_role: 'owner_intake', agent_profile: 'owner', mentions: [{ id: 'bot' }], content: '你好' };
  const context = app.conversations.context;
  await handleLarkCliEvent(context, event); await app.conversations.idle();
  assert.equal(aiCalls, 1); assert.deepEqual(calls.map((c) => c.type), ['send', 'patch']);
  assert.match(JSON.stringify(calls[1].card), /AI 的真实回答/);
  assert.equal((await app.store.read()).jobs.length, 0);
  await handleLarkCliEvent(context, { ...event, message_id: 'm2', mentions: [], reply_to: 'om_card', content: '继续' });
  await app.conversations.idle(); assert.equal(aiCalls, 2);
});

test('real job notifications share an execution card, and stale progress renders final state', async (t) => {
  const { store, cards, client, calls } = await setup(t);
  const { job } = await store.createJob({ projectId: 'demo', projectName: 'demo', chatId: 'group', stage: 'developer',
    agentProfile: 'dev', instruction: '只测试', workflow: 'single_developer', status: 'running' });
  const context = { store, cards, feishu: client };
  const began = await store.appendEvent(job.id, { type: 'started' });
  await notifyJobEvent(context, began);
  const key = `job:${job.id}:${began.event.id}`; await cards.flush(key, true);
  const progress = await store.appendEvent(job.id, { type: 'progress', phase: 'tool_activity', activity: {
    total: 1, completed: 1, current: '正在处理后续步骤', recent: [{ label: 'git diff --stat', done: true, failed: false }] } });
  await notifyJobEvent(context, progress); await cards.flush(key, true);
  const final = await store.appendEvent(job.id, { type: 'completed', result: { outcome: 'blocked', finalMessage: '测试未通过' } });
  await notifyJobEvent(context, final); await notifyJobEvent(context, progress);
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.at(-1).card.header.template, 'red');
  assert.match(JSON.stringify(calls.at(-1).card), /测试未通过|git diff --stat/);
});
