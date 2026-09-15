const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export function requesterMentionText(userId, message) {
  if (!OPEN_ID.test(String(userId ?? ''))) return null;
  return `<at user_id="${userId}"></at> ${message}`;
}

export function conversationTerminalMention(turn) {
  if (turn?.chatType !== 'group') return null;
  return mention(turn.messageId, turn.profile, turn.senderId, '本次回复已完成，请查看上方结果。');
}

export function jobTerminalMention(job, projects = {}) {
  if (job?.originChatType !== 'group' || job.nextJobId) return null;
  if (!['completed', 'blocked', 'failed', 'cancelled'].includes(job.status)) return null;
  const replyTo = job.originMessageId ?? job.replyToMessageId;
  if (job.taskIntent === 'analysis' && job.status === 'blocked' && job.result?.sourceSyncBlocked === true) {
    const administrators = projects.ownerOpenIdsByProfile?.[job.originProfile] ?? projects.ownerOpenIds ?? [];
    const ids = [...new Set([job.senderId, ...(Array.isArray(administrators) ? administrators : [])])]
      .filter((id) => OPEN_ID.test(String(id ?? '')));
    if (!replyTo || !ids.length) return null;
    return { replyTo, profile: job.originProfile ?? null,
      text: `${ids.map((id) => `<at user_id="${id}"></at>`).join(' ')} 源码同步受阻，请管理员查看上方原因并决定处理方式；未自动解决冲突。` };
  }
  return mention(replyTo, job.originProfile, job.senderId, '任务已结束，请查看上方结果。');
}

function mention(replyTo, profile, userId, message) {
  const text = requesterMentionText(userId, message);
  return replyTo && text ? { replyTo, profile: profile ?? null, text } : null;
}
