// Explicit presentation switch, never inferred from model output or attachments.
export const requestsPrivateCard = text => /^\s*(?:仅我可见|\/private)(?:[\s：:，,]|$)/u.test(String(text??''));
export const isPrivate = (state,record) => record?.visibility==='requester'||state.questions?.[record?.questionId]?.visibility==='requester';
export function cardDestination(record){return record.visibility==='requester'
 ? {visibility:'requester',chatId:record.chatId,openId:record.senderId,profile:record.profile??record.originProfile??record.agentProfile,...(record.directoryChannel?{strictGroup:true,contactChannel:{...record.directoryChannel,requesterId:record.senderId},questionId:record.questionId??record.id,sourceKey:'question:'+(record.questionId??record.id)}:{} )}
 : {replyTo:record.messageId,profile:record.profile,...(record.replyInThread?{replyInThread:true}:{})};}
export function privateRecipient(state,record){if(!isPrivate(state,record))return undefined;const q=state.questions?.[record.questionId];const id=q?.senderId??record.senderId;if(!/^ou_[A-Za-z0-9]+$/.test(id??''))throw new Error('Private recipient missing');return id;}

export function cardActionChat(entry,event){
 if(entry.destination.visibility!=='requester')return event.chat_id;
 if(entry.destination.openId!==event.operator_id)throw new Error('Private recipient mismatch');
 if(entry.privateDeliveryKind==='dm'){
  if(!entry.privateDeliveryChatId||event.chat_id!==entry.privateDeliveryChatId)throw new Error('Private DM scope mismatch');
  return entry.destination.chatId;
 }
 return event.chat_id;
}
