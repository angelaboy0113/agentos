const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export function requesterMentionText(userId, message) {
  if (!OPEN_ID.test(String(userId ?? ''))) return null;
  return `<at user_id="${userId}"></at> ${message}`;
}

export function conversationTerminalMention(turn) {
  if (turn?.chatType !== 'group') return null;
  return mention(turn.messageId, turn.profile, turn.senderId, '本次回复已完成，请查看上方结果。');
}

export function jobTerminalMention(job) {
  if (job?.originChatType !== 'group' || job.nextJobId) return null;
  if (!['completed', 'blocked', 'failed', 'cancelled'].includes(job.status)) return null;
  return mention(job.originMessageId ?? job.replyToMessageId, job.originProfile, job.senderId, '任务已结束，请查看上方结果。');
}

function mention(replyTo, profile, userId, message) {
  const text = requesterMentionText(userId, message);
  return replyTo && text ? { replyTo, profile: profile ?? null, text } : null;
}
