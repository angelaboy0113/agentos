import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createControlPlane, handleLarkCliEvent } from '../src/control-plane/server.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { loadProjects, saveProjects } from '../src/control-plane/config.js';
import { LarkCliFeishuClient } from '../src/control-plane/lark-cli.js';
import { FeishuClient } from '../src/control-plane/feishu.js';
async function appFixture(t, topic = true) {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-topic-')); const calls = []; let decisions = 0;
 const client = { replyCard: async (id, card, options) => { calls.push({ kind: 'card', id, options }); return { message_id: `card-${id}` }; },
  updateCard: async (id, card, options) => { calls.push({ kind: 'update', id, options }); }, reply: async (id, text, options) => { calls.push({ kind: 'mention', id, options }); } };
 const app = await createControlPlane({ dataDir: dir, storeFile: path.join(dir, 'state.json'), feishuClient: client,
  projects: { projects: { demo: {} }, chatProjectMap: { current: 'demo' }, topicChatIds: topic ? ['current'] : [], retiredChatIds: ['old'], ownerOpenIdsByProfile: { owner: ['ou_admin'] } },
  agents: { agents: { owner_intake: { profile: 'owner', openId: 'ou_bot' } } },
  conversationOptions: { groupSessions: true, questionCards: true },
  conversationResponder: async () => { decisions++; return { action: 'reply', intent: 'none', reply: '测试回答', environmentQuery: null }; } });
 t.after(async () => { await app.conversations.stop(); await app.cards.stop(); await rm(dir, { recursive: true, force: true }); });
 const send = async (id, extra = {}) => { const result = await handleLarkCliEvent(app, { type: 'im.message.receive_v1', message_id: id, chat_id: 'current', chat_type: 'group', sender_id: 'ou_admin', agent_profile: 'owner', agent_role: 'owner_intake', mentions: [{ id: 'ou_bot' }], content: '你好', ...extra }); await app.conversations.idle(); return result; };
 return { app, calls, send, decisions: () => decisions };
}
test('topic questions keep separate cards and thread replies/mentions on the original question', async t => {
 const { app, calls, send } = await appFixture(t); await send('root-one'); await send('root-two'); await send('follow-up', { root_id: 'root-one', reply_to: 'root-one' });
 const s = await app.store.read(); assert.equal(Object.keys(s.questions).length, 2); assert.equal(s.jobs.length, 0);
 assert.equal(s.conversations[0].questionId, s.conversations[2].questionId); assert.notEqual(s.conversations[0].questionId, s.conversations[1].questionId);
 assert.ok(calls.length >= 4); assert.ok(calls.every(c => c.options.replyInThread === true));
 assert.deepEqual(calls.filter(c => c.kind === 'card').map(c => c.id), ['root-one', 'root-two']);
});
test('normal groups retain ordinary reply mode', async t => {
 const { calls, send } = await appFixture(t, false); await send('normal-root');
 assert.ok(calls.every(c => c.options.replyInThread !== true));
});
test('retired groups do not reach AI or create work, and old action buttons cannot resume tasks', async t => {
 const { app, send, decisions } = await appFixture(t);
 assert.equal((await send('old-message', { chat_id: 'old' })).reason, 'retired_group'); assert.equal(decisions(), 0);
 assert.equal((await app.store.read()).conversations?.length ?? 0, 0);
 const response = await handleCardAction(app, { type: 'card.action.trigger', event_id: 'old-click', operator_id: 'ou_admin', agent_profile: 'owner', chat_id: 'old', action_value: { action: 'approve' } });
 assert.equal(response.reason, 'retired_group');
});
test('topic and retired group settings persist and reject malformed or overlapping groups', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-topic-config-')); t.after(() => rm(dir, { recursive: true, force: true })); const f = path.join(dir, 'projects.json');
 await writeFile(f, JSON.stringify({ projects: {}, topicChatIds: ['topic'], retiredChatIds: ['old'] })); const p = await loadProjects(f); await saveProjects(f, p);
 assert.deepEqual((await loadProjects(f)).topicChatIds, ['topic']); assert.deepEqual((await loadProjects(f)).retiredChatIds, ['old']);
 for (const value of [{ topicChatIds: 'topic' }, { topicChatIds: ['topic'], retiredChatIds: ['topic'] }]) { await writeFile(f, JSON.stringify(value)); await assert.rejects(loadProjects(f)); }
});
test('CLI adapter includes explicit thread flag only for topic replies, including cards', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-topic-cli-')); t.after(() => rm(dir, { recursive: true, force: true })); const cliEntry = path.join(dir, 'fake-cli.cjs');
 await writeFile(cliEntry, 'console.log(JSON.stringify({ok:true,data:{args:process.argv.slice(2)}}));');
 const client = new LarkCliFeishuClient({ cliEntry, dataDir: dir });
 for (const kind of ['reply', 'replyCard']) { const payload = kind === 'reply' ? 'synthetic' : { synthetic: true };
  const a = await client[kind]('synthetic-message', payload, { profile: 'synthetic-profile', replyInThread: true, idempotencyKey: 'synthetic' }); assert.ok(a.data.args.includes('--reply-in-thread'));
  const b = await client[kind]('synthetic-message', payload, { profile: 'synthetic-profile', idempotencyKey: 'synthetic' }); assert.ok(!b.data.args.includes('--reply-in-thread'));
 }
});
test('OpenAPI adapter forwards thread mode for both text and card replies', async t => {
 const bodies = []; const prior = globalThis.fetch; globalThis.fetch = async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) }; }; t.after(() => { globalThis.fetch = prior; });
 const client = new FeishuClient({ appId: 'synthetic', appSecret: 'synthetic' }); client.token = 'synthetic'; client.tokenExpiresAt = Date.now() + 10000;
 await client.reply('synthetic', 'test', { replyInThread: true }); await client.replyCard('synthetic', {}, { replyInThread: true }); await client.reply('synthetic', 'normal');
 assert.equal(bodies[0].reply_in_thread, true); assert.equal(bodies[1].reply_in_thread, true); assert.equal(bodies[2].reply_in_thread, undefined);
});
