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
