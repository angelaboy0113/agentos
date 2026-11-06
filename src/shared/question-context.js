// Reply ancestry is reading context, never authority to mutate another user's task.
export function questionContextIds(state, actor, projectId = actor.projectId) {
  const ids = new Set();
  const allowed = q => q && q.chatId === actor.chatId && q.projectId === projectId
    && q.profile === (actor.profile ?? actor.originProfile ?? actor.agentProfile)
    && (q.visibility !== 'requester' || actor.visibility === 'requester' && q.senderId === actor.senderId);
  let q = state.questions?.[actor.questionId];
  while (allowed(q) && !ids.has(q.id)) {
    ids.add(q.id);
    let parent = state.questions?.[q.parentQuestionId];
    // Recover old orphan replies only from the exact durable topic-root message.
    // Never select a latest group question or follow a caller-supplied Job ID.
    if (!parent && q.threadRootId && q.threadRootId !== q.messageId) {
      parent = Object.values(state.questions ?? {}).find(candidate => allowed(candidate)
        && candidate.messageId === q.threadRootId && candidate.id !== q.id
        && (!q.createdAt || !candidate.createdAt || candidate.createdAt <= q.createdAt));
    }
    q = parent;
  }
  return ids;
}
