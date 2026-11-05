import {createHash,randomInt} from 'node:crypto';
import {isAdministrator} from './authorization.js';
import {messageIdOf} from './live-cards.js';
import {reportEligible} from '../shared/report-acceptance.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export const validStickerKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(key);
export const stickerIdentity = agent => agent?.successStickers === true && agent.profile && agent.appId
  ? `${agent.profile}:${agent.appId}` : null;
const now = () => new Date().toISOString();
const values = x => Object.values(x ?? {});
const busy = status => ['queued','thinking','decided','ready','running','cancelling','awaiting_approval','awaiting_clarification','awaiting_environment_approval'].includes(status);

// Display colour alone is never evidence that a business request succeeded.
export function stickerSuccess(state,q,card,agent,library) {
  if(!q || !library?.items?.length || !(Date.parse(q.createdAt)>=Date.parse(library.activatedAt))
    || q.profile!==agent.profile || q.projectId!==agent.projectId || q.visibility==='requester' || q.directoryChannel
    || agent.allowedChatIds && !agent.allowedChatIds.includes(q.chatId)
    || card?.questionRound?.generation!==q.generation || card?.questionRound?.turnId!==q.latestTurnId
    || !card?.terminal || !card.messageId || card.destination?.visibility==='requester'
    || card.destination?.profile!==q.profile || card.destination?.replyTo!==q.messageId
    || card.revision!==card.deliveredRevision || card.error || !card.mentionDelivered
    || !card.terminalMention || card.terminalMention.kind || card.terminalMention.profile!==q.profile
    || card.card?.header?.template!=='green')return false;
  const turns=(state.conversations??[]).filter(t=>t.questionId===q.id),jobs=(state.jobs??[]).filter(j=>j.questionId===q.id);
  const root=turns.find(t=>t.id===q.rootTurnId),turn=turns.find(t=>t.id===q.latestTurnId),job=jobs.at(-1);
  if(root?.chatType!=='group' || root.profile!==q.profile || root.chatId!==q.chatId
    || !turn || turn.status!=='sent' || turn.aiFailed || turn.actionError || turn.setupPending
    || turns.some(t=>busy(t.status)) || jobs.some(j=>busy(j.status) || j.visibility==='requester'))return false;
  if(job){if(job.status!=='completed'||job.nextJobId||job.result?.outcome!=='ready'||job.result?.browserLoginRequired)return false;}
  else if(turn.decision?.action!=='reply' || !turn.response || turn.outcome?.jobId || turn.outcome?.nextJobId)return false;
  if(values(state.environmentEnrollments).some(e=>e.questionId===q.id&&!['complete','cancelled','failed','superseded','expired'].includes(e.status)))return false;
  // A successful result can race report enqueue/recovery. Require receipts for
  // every accepted component, not merely an empty outbox observed too early.
  if(job){
    const files=jobs.flatMap(source=>(source.reportFiles??[]).filter(f=>f.questionGeneration===q.generation&&reportEligible(job.reportReviews?job:source,f)));
    const manifest=job.reportDeliverySet?.files;
    const required=manifest?.length ? manifest : files.slice(-1).map(f=>({fileId:f.id,verificationHash:f.verificationHash}));
    if((job.tabularDelivery||job.result?.reportAssessment?.decision==='deliver'||job.reportDeliverySet)&&!required.length)return false;
    if(manifest?.length && required.some(m=>!files.some(f=>f.id===m.fileId&&f.verificationHash===m.verificationHash)))return false;
    if(required.some(m=>!values(state.reportDeliveries).some(e=>e.questionId===q.id&&e.questionGeneration===q.generation&&!e.superseded&&e.messageId&&e.item?.id===m.fileId&&e.item.verificationHash===m.verificationHash)))return false;
  }
  return ![...values(state.reportDeliveries),...values(state.websiteEvidenceDeliveries)].some(e=>e.questionId===q.id&&e.questionGeneration===q.generation&&!e.superseded&&!e.messageId);
}

export class SuccessStickers {
  constructor(context,{choose=randomInt}={}){this.context=context;this.choose=choose;this.workers=new Map();this.closed=false;}
  agent(profile){return values(this.context.agents.agents).find(a=>a.profile===profile);}
  async handle(event){
    if(event.message_type!=='sticker')return null;
    const agent=this.agent(event.agent_profile),identity=stickerIdentity(agent);
    if(!identity||event.chat_type!=='p2p'||event.sender_type!=='user'
      || !isAdministrator(this.context.projects,{profile:agent.profile,senderId:event.sender_id}))return {ignored:true,reason:'sticker_registration_not_allowed'};
    const id=event.message_id??event.id;
    if(!id || !event.chat_id)throw Error('Sticker registration message identity missing');
    const key=digest(`${identity}:${id}`);
    const prior=await this.context.store.select(s=>s.stickerRegistrations?.[key]);
    if(!prior){
      // Fetch even when the event contains a key: the same bot's native read is
      // authoritative for placeholders, sender identity and conversation scope.
      const raw=await this.context.feishu.getMessage(id,{profile:agent.profile});
      if(!raw)throw Error('Native sticker message not yet available');
      if(raw?.message_id!==id||raw.chat_id!==event.chat_id||raw.message_type!=='sticker'
        ||raw.sender?.sender_type!=='user'||raw.sender?.id_type!=='open_id'||raw.sender.id!==event.sender_id
        ||raw.deleted)return {ignored:true,reason:'sticker_message_scope_mismatch'};
      const chat=await this.context.feishu.chatInfo(event.chat_id,{profile:agent.profile});
      if(chat?.chat_mode!=='p2p')return {ignored:true,reason:'sticker_requires_native_p2p'};
      let content;try{content=JSON.parse(raw.body?.content);}catch{throw Error('Native sticker content unavailable');}
      if(!validStickerKey(content?.file_key))throw Error('Native sticker file_key unavailable');
      await this.context.store.transact(s=>{
        s.stickerRegistrations??={};if(s.stickerRegistrations[key])return;
        s.stickerLibraries??={};const library=s.stickerLibraries[identity]??={profile:agent.profile,appId:agent.appId,activatedAt:now(),items:[]};
        if(!library.items.some(x=>x.fileKey===content.file_key))library.items.push({fileKey:content.file_key,registeredAt:now(),sourceMessageId:id,registeredBy:event.sender_id});
        s.stickerRegistrations[key]={identity,profile:agent.profile,messageId:id,chatId:event.chat_id,senderId:event.sender_id,count:library.items.length,createdAt:now()};
      });
    }
    await this.registrationReceipt(key);
    return {ok:true,stickerRegistered:true,count:(await this.context.store.select(s=>s.stickerRegistrations[key])).count};
  }
  async registrationReceipt(key){
    if(this.workers.has('r:'+key))return this.workers.get('r:'+key);
    const work=(async()=>{
      const e=await this.context.store.select(s=>s.stickerRegistrations?.[key]);if(!e||e.receiptId||Date.now()<(e.retryAt??0))return;
      if(stickerIdentity(this.agent(e.profile))!==e.identity||!isAdministrator(this.context.projects,{profile:e.profile,senderId:e.senderId}))return;
      if(e.firstAttemptAt&&Date.now()-e.firstAttemptAt>=55*60*1000){await this.markReconcile('stickerRegistrations',key);return;}
      await this.context.store.transact(s=>{s.stickerRegistrations[key].firstAttemptAt??=Date.now();});
      try{
        const sent=await this.context.feishu.reply(e.messageId,`原生表情包已登记，素材库现有 ${e.count} 张`,{profile:e.profile,idempotencyKey:'aos-sticker-reg-'+key.slice(0,32)});
        const receiptId=messageIdOf(sent);if(!receiptId)throw Error('Registration receipt missing');
        await this.context.store.transact(s=>Object.assign(s.stickerRegistrations[key],{receiptId,deliveredAt:now(),retryAt:0,error:null}));
      }catch{await this.failed('stickerRegistrations',key);}
    })();this.workers.set('r:'+key,work);try{await work;}finally{this.workers.delete('r:'+key);}
  }
  async retry(){
    if(this.closed||this.retrying)return this.retrying;
    const work=this.recover();this.retrying=work;try{await work;}finally{this.retrying=null;}
  }
  async snapshot(){
    return this.context.store.select(s=>{
      const questions=values(s.questions).filter(q=>{
        const a=this.agent(q.profile),identity=stickerIdentity(a),library=s.stickerLibraries?.[identity],card=s.cardMessages?.['question:'+q.id];
        return library?.items?.length&&Date.parse(q.createdAt)>=Date.parse(library.activatedAt)
          &&card?.terminal&&card.card?.header?.template==='green'
          &&!s.stickerDeliveries?.[digest(`${identity}:${q.id}:${q.generation}`)];
      });
      const ids=new Set(questions.map(q=>q.id));
      for(const e of values(s.stickerDeliveries))if(!e.messageId&&!e.superseded)ids.add(e.questionId);
      return {stickerLibraries:s.stickerLibraries,stickerRegistrations:s.stickerRegistrations,stickerDeliveries:s.stickerDeliveries,
        questions:Object.fromEntries(values(s.questions).filter(q=>ids.has(q.id)).map(q=>[q.id,q])),
        cardMessages:Object.fromEntries([...ids].map(id=>['question:'+id,s.cardMessages?.['question:'+id]])),
        jobs:(s.jobs??[]).filter(j=>ids.has(j.questionId)).map(j=>({...j,events:[],context:[],sourceSnapshot:null})),
        conversations:(s.conversations??[]).filter(t=>ids.has(t.questionId)).map(t=>({...t,context:[],attachments:[]})),
        environmentEnrollments:Object.fromEntries(Object.entries(s.environmentEnrollments??{}).filter(([,e])=>ids.has(e.questionId))),
        reportDeliveries:Object.fromEntries(Object.entries(s.reportDeliveries??{}).filter(([,e])=>ids.has(e.questionId))),
        websiteEvidenceDeliveries:Object.fromEntries(Object.entries(s.websiteEvidenceDeliveries??{}).filter(([,e])=>ids.has(e.questionId)))};
    });
  }
  async recover(){
    const snapshot=await this.snapshot();
    for(const [key,e]of Object.entries(snapshot.stickerRegistrations??{}))if(!e.receiptId&&!e.reconciliationRequired)await this.registrationReceipt(key);
    if(typeof this.context.feishu.replySticker!=='function'||!Object.keys(snapshot.stickerLibraries??{}).length)return;
    const candidates=values(snapshot.questions).filter(q=>{
      const a=this.agent(q.profile),identity=stickerIdentity(a);return identity&&stickerSuccess(snapshot,q,snapshot.cardMessages?.['question:'+q.id],a,snapshot.stickerLibraries[identity]);
    });
    for(const q of candidates){
      const a=this.agent(q.profile),identity=stickerIdentity(a),card=snapshot.cardMessages['question:'+q.id];
      const key=digest(`${identity}:${q.id}:${q.generation}`);
      if(snapshot.stickerDeliveries?.[key])continue;
      await this.context.store.transact(s=>{
        s.stickerDeliveries??={};if(s.stickerDeliveries[key])return;
        const current=s.questions?.[q.id],latest=s.cardMessages?.['question:'+q.id],library=s.stickerLibraries?.[identity];
        if(latest?.generation!==card.generation||!stickerSuccess(s,current,latest,a,library))return;
        const chosen=library.items[this.choose(library.items.length)];
        s.stickerDeliveries[key]={identity,profile:a.profile,questionId:q.id,generation:card.generation,questionGeneration:q.generation,
          fileKey:chosen.fileKey,destination:{messageId:q.messageId,chatId:q.chatId,replyInThread:q.replyInThread===true,profile:a.profile},createdAt:now(),idempotencyKey:'aos-sticker-'+key.slice(0,36)};
      });
    }
    const pending=await this.context.store.select(s=>Object.entries(s.stickerDeliveries??{}).filter(([,e])=>!e.messageId&&!e.superseded&&!e.reconciliationRequired&&Date.now()>=(e.retryAt??0)));
    for(const [key,e]of pending)await this.deliver(key,e);
  }
  async deliver(key,e){
    if(this.closed)return;
    const fresh=await this.snapshot(),q=fresh.questions?.[e.questionId],card=fresh.cardMessages?.['question:'+e.questionId],a=this.agent(e.profile);
    if(stickerIdentity(a)!==e.identity||!q||q.generation!==e.questionGeneration||q.messageId!==e.destination.messageId||q.chatId!==e.destination.chatId){
      await this.context.store.transact(s=>{s.stickerDeliveries[key].superseded=true;});return;
    }
    const library=fresh.stickerLibraries?.[e.identity];
    if(!stickerSuccess(fresh,q,card,a,library)||!library.items.some(x=>x.fileKey===e.fileKey))return;
    // Feishu deduplicates UUIDs for one hour. Do not risk an unconfirmed second
    // send beyond that platform window; only this optional outbox waits review.
    if(e.firstAttemptAt&&Date.now()-e.firstAttemptAt>=55*60*1000){await this.markReconcile('stickerDeliveries',key);return;}
    await this.context.store.transact(s=>{s.stickerDeliveries[key].firstAttemptAt??=Date.now();});
    try{
      const result=await this.context.feishu.replySticker(e.destination.messageId,e.fileKey,{...e.destination,idempotencyKey:e.idempotencyKey});
      const messageId=messageIdOf(result);if(!messageId)throw Error('Sticker receipt missing');
      await this.context.store.transact(s=>Object.assign(s.stickerDeliveries[key],{messageId,deliveredAt:now(),failures:0,retryAt:0,error:null}));
    }catch{await this.failed('stickerDeliveries',key);}
  }
  async failed(collection,key){await this.context.store.transact(s=>{const e=s[collection]?.[key];if(!e)return;e.failures=(e.failures??0)+1;e.retryAt=Date.now()+Math.min(300000,e.failures*5000);e.error='表情包投递尚未确认，将沿用原素材及幂等键重试';});}
  async markReconcile(collection,key){await this.context.store.transact(s=>Object.assign(s[collection][key],{reconciliationRequired:true,error:'超过平台去重窗口前暂停未确认投递，需核对回执；业务结果不受影响'}));}
  async close(){this.closed=true;await this.retrying;await Promise.allSettled(this.workers.values());}
}
