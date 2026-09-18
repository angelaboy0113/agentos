import { publishQuestion } from './questions.js';
import { jobCard } from './message-cards.js';
const pending=new WeakMap();
// Refresh presentation once when an outstanding grant expires. Never renew or approve it automatically.
export function refreshExpiredApprovalCards(context,now=Date.now()){
 if(!context.cards?.enabled)return Promise.resolve();
 if(pending.has(context))return pending.get(context);
 const work=refresh(context,now).finally(()=>pending.delete(context));pending.set(context,work);return work;
}
async function refresh(context,now){
 const state=await context.store.read();
 for(const job of state.jobs){
  if(job.status!=='awaiting_environment_approval'||Date.parse(job.environmentAccess?.expiresAt)>now)continue;
  const entry=Object.entries(state.cardMessages??{}).find(([key,v])=>v.messageId&&(job.questionId?key===`question:${job.questionId}`:key.startsWith(`job:${job.id}:`)));
  if(!entry||!JSON.stringify(entry[1].card).includes('"action":"approve_environment"'))continue;
  if(job.questionId)await publishQuestion(context,job.questionId);
  else await context.cards.upsert(entry[0],jobCard(job,now),entry[1].destination,{terminal:true,immediate:true,resultText:job.result?.finalMessage??''});
 }
}
