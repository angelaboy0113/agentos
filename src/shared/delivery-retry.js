import{createHash}from'node:crypto';
export const DELIVERY_GROUPS=['cardMessages','reportDeliveries','websiteEvidenceDeliveries','stickerDeliveries','stickerRegistrations'];
export function deliveryFingerprint(group,e){
 const value=group==='cardMessages'?[e.card,e.destination,e.generation,e.questionRound,e.terminalMention]:group==='stickerRegistrations'?[e.identity,e.profile,e.senderId,e.messageId,e.count]:[e.sourceJobId,e.questionId,e.questionGeneration,e.destination,e.item,e.identity,e.profile,e.fileKey,e.idempotencyKey];
 return createHash('sha256').update(JSON.stringify([group,value])).digest('hex');
}
export function deliveryHeld(group,e){return Boolean(e?.deliveryRetry?.state==='attention'&&e.deliveryRetry.fingerprint===deliveryFingerprint(group,e));}
export function deliveryFailure(group,current,attempted,error,now=Date.now()){
 if(!current||deliveryFingerprint(group,current)!==deliveryFingerprint(group,attempted))return false;
 const fingerprint=deliveryFingerprint(group,current),prior=current.deliveryRetry?.fingerprint===fingerprint?current.deliveryRetry:null;
 if(prior?.state==='attention')return false;
 // Save only allowlisted classifications, never raw SDK errors, URLs or tokens.
 const status=Number(error?.status??error?.statusCode??/\bHTTP (\d{3})\b/.exec(String(error?.message??''))?.[1]),code=String(error?.code??'');
 const permanent=[400,401,403,404,413,422].includes(status)||['DELIVERY_PERMISSION_DENIED','DELIVERY_INVALID_PAYLOAD','DELIVERY_INTEGRITY','ENOENT','EACCES','EPERM','ELOOP'].includes(code)||/(?:\b11310\b|card table number over limit)/i.test(String(error?.message??''));
 const attempts=(prior?.attempts??0)+1,firstFailureAt=prior?.firstFailureAt??now;
 current.deliveryRetry={policy:'delivery-retry-v1',fingerprint,state:permanent||attempts>=12&&now-firstFailureAt>=1800000?'attention':'retrying',attempts,firstFailureAt,lastFailureAt:now,reason:permanent?'platform_rejected':'repeated_no_progress',errorClass:permanent?'permanent_rejection':'transport_or_validation'};
 if(current.deliveryRetry.state==='attention'){current.deliveryRetry.heldAt=now;current.error='投递待维护：已停止自动重试，原结果与回执保留';}
 return true;
}
export function deliveryPending(group,e){return group==='cardMessages'?(e.revision!==e.deliveredRevision||e.terminalMention&&!e.mentionDelivered):group==='stickerRegistrations'?!e.receiptId:!e.deliveredAt&&!e.superseded&&(!e.messageId||e.parts?.some(p=>!p.messageId));}
export function deliveryAttention(state){return DELIVERY_GROUPS.flatMap(group=>Object.entries(state[group]??{}).filter(([,e])=>deliveryPending(group,e)&&deliveryHeld(group,e)).map(([key,e])=>({group,key,fingerprint:e.deliveryRetry.fingerprint,questionId:e.questionId??(key.startsWith('question:')?key.slice(9):null),profile:e.destination?.profile??e.profile,reconciliationRequired:e.reconciliationRequired===true,attempts:e.deliveryRetry.attempts,reason:e.deliveryRetry.reason,heldAt:e.deliveryRetry.heldAt})));}
export function resumeDelivery(state,{group,key,fingerprint},at=Date.now()){
 if(!DELIVERY_GROUPS.includes(group))throw Error('Invalid delivery group');const e=state[group]?.[key];
 if(e?.reconciliationRequired)throw Error('Receipt reconciliation required before resuming');
 if(!e||!deliveryHeld(group,e)||e.deliveryRetry.fingerprint!==fingerprint)throw Error('Delivery changed; refresh before retry');
 state.adminAudit??=[];state.adminAudit.push({at:new Date(at).toISOString(),type:'delivery_resume',group,key,prior:structuredClone(e.deliveryRetry)});
 e.deliveryRetry={policy:'delivery-retry-v1',fingerprint,state:'retrying',attempts:0,reviewedAt:at};e.retryAt=0;
 // Receipts, file selection, original identities and idempotency keys stay intact.
 return {group,key,resumed:true};
}
