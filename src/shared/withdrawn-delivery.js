import{createHash}from'node:crypto';
export const withdrawalCardHash=c=>createHash('sha256').update(JSON.stringify([c.card,c.destination,c.generation,c.questionRound,c.terminalMention])).digest('hex');
// Suppression is not a receipt. Only the exact payload bound to an API-confirmed
// withdrawn question is idle; a new payload, route or live worker stays protected.
export function withdrawnCardInert(state,key,c){const p=c?.sourceWithdrawal,q=state.questions?.[p?.questionId];return Boolean(p&&q&&key==='question:'+q.id&&q.withdrawnAt===p.at&&q.withdrawnMessageId===p.messageId&&[q.messageId,q.threadRootId].includes(p.messageId)&&q.profile===p.profile&&q.chatId===p.chatId&&c.destination?.profile===q.profile&&c.destination?.replyTo===q.messageId&&c.error==='原消息已撤回，停止更新'&&p.cardHash===withdrawalCardHash(c));}
