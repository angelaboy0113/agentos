import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTerminalMention, jobTerminalMention, requesterMentionText } from '../src/control-plane/requester-mention.js';

test('native mentions accept only Feishu open IDs and group origins', () => {
  assert.equal(requesterMentionText('ou_abc123', '完成'), '<at user_id="ou_abc123"></at> 完成');
  assert.equal(requesterMentionText('all', '完成'), null);
  assert.equal(requesterMentionText('ou_bad\"></at><at user_id="all', '完成'), null);
  assert.equal(conversationTerminalMention({ chatType: 'p2p', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), null);
  assert.deepEqual(conversationTerminalMention({ chatType: 'group', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), {
    replyTo: 'm', profile: 'owner', text: '<at user_id="ou_abc123"></at> 本次回复已完成，请查看上方结果。',
  });
});

test('task mentions only final mission outcomes and retains the originating bot identity', () => {
  const job = { originChatType: 'group', originMessageId: 'm-origin', replyToMessageId: 'm-latest',
    originProfile: 'owner', senderId: 'ou_abc123', status: 'completed' };
  assert.equal(jobTerminalMention({ ...job, status: 'awaiting_approval' }), null);
  assert.equal(jobTerminalMention({ ...job, nextJobId: 'JOB-next' }), null);
  assert.deepEqual(jobTerminalMention(job), {
    replyTo: 'm-origin', profile: 'owner', text: '<at user_id="ou_abc123"></at> 任务已结束，请查看上方结果。',
  });
});

test('source sync blocks mention origin-profile admins with deduplication and legacy fallback', () => {
  const job = { taskIntent: 'analysis', status: 'blocked', originChatType: 'group', originMessageId: 'm',
    originProfile: 'owner', agentProfile: 'dev', senderId: 'ou_member', result: { sourceSyncBlocked: true } };
  const config = { ownerOpenIdsByProfile: { owner: ['ou_admin', 'ou_admin', 'all'], dev: ['ou_wrongApp'] }, ownerOpenIds: ['ou_legacy'] };
  const text = jobTerminalMention(job, config).text;
  assert.equal((text.match(/<at /g) ?? []).length, 2);
  assert.match(text, /ou_member/); assert.match(text, /ou_admin/);
  assert.doesNotMatch(text, /ou_wrongApp|ou_legacy|user_id="all"/);
  assert.equal((jobTerminalMention({ ...job, senderId: 'ou_admin' }, config).text.match(/<at /g) ?? []).length, 1);
  assert.doesNotMatch(jobTerminalMention(job, { ...config, ownerOpenIdsByProfile: { owner: [] } }).text, /ou_legacy/);
  assert.match(jobTerminalMention(job, { ownerOpenIds: ['ou_legacy'] }).text, /ou_legacy/);
  assert.equal(jobTerminalMention({ ...job, originChatType: 'p2p' }, config), null);
  for (const result of [{}, { finalMessage: '源码同步受阻' }]) {
    assert.doesNotMatch(jobTerminalMention({ ...job, result }, config).text, /ou_admin/);
  }
});
