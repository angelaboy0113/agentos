import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionStickers } from '../src/control-plane/completion-stickers.js';

function fixture() {
  const profile = 'owner';
  const state = { jobs: [], cardMessages: {}, questions: {}, reportDeliveries: {} };
  const replies = [], stickers = [];
  const service = new CompletionStickers({
    projects: { ownerOpenIdsByProfile: { owner: ['ou_admin'] } },
    agents: { agents: { owner_intake: { profile } } },
    store: { read: async () => state, transact: async fn => fn(state) },
    feishu: {
      reply: async (...args) => replies.push(args),
      readStickerKey: async () => 'file_native',
      replySticker: async (...args) => {
        stickers.push(args);
        return { data: { message_id: 'om_sticker' } };
      },
    },
  });
  const event = {
    message_id: 'om_input', chat_id: 'oc_dm', chat_type: 'p2p',
    sender_id: 'ou_admin', sender_type: 'user', content: '[sticker]',
  };
  return { service, state, replies, stickers, profile, event };
}

test('only the owner profile administrator can enroll native stickers privately', async () => {
  const { service, state, replies, profile, event } = fixture();
  for (const invalid of [{ sender_id: 'ou_other' }, { chat_type: 'group' }, { sender_type: 'bot' }]) {
    assert.deepEqual(await service.receive({ ...event, ...invalid }, profile), { ignored: true });
  }
  assert.deepEqual(await service.receive(event, 'other'), { ignored: true });
  assert.equal(state.completionStickers, undefined);
  await service.receive(event, profile);
  await service.receive({ ...event, content: '{"file_key":"file_native"}' }, profile);
  assert.deepEqual(state.completionStickers.owner.keys, ['file_native']);
  assert.equal(replies[0][2].idempotencyKey, replies[1][2].idempotencyKey);
});

test('completion waits for the exact report and completion notice, then sends once in the original thread', async () => {
  const { service, state, stickers, profile, event } = fixture();
  await service.receive(event, profile);
  const card = state.cardMessages['question:q'] = {
    terminal: true, stickerEligible: 1, generation: 1, messageId: 'om_card',
    revision: 2, deliveredRevision: 2, mentionDelivered: false,
    destination: { profile, replyTo: 'om_original', replyInThread: true },
  };
  state.questions.q = { id: 'q', generation: 1, createdAt: new Date().toISOString() };
  state.jobs.push({ questionId: 'q', reportFiles: [{ id: 'file-report', questionGeneration: 1, verificationHash: 'a'.repeat(64) }] });
  await service.retry();
  card.mentionDelivered = true;
  await service.retry();
  assert.equal(stickers.length, 0);
  state.reportDeliveries.f = { questionId: 'q', questionGeneration: 1, item: { id: 'file-report' }, messageId: 'om_report' };
  card.destination.visibility = 'requester';
  await service.retry();
  assert.equal(stickers.length, 0);
  card.destination.visibility = 'public';
  await Promise.all([service.retry(), service.retry()]);
  await service.retry();
  assert.equal(stickers.length, 1);
  assert.deepEqual(stickers[0].slice(0, 2), ['om_original', 'file_native']);
  assert.equal(stickers[0][2].replyInThread, true);
});
