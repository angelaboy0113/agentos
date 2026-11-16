import test from 'node:test';
import assert from 'node:assert/strict';
import {jobTerminalMention} from '../src/control-plane/requester-mention.js';
import {LiveCards} from '../src/control-plane/live-cards.js';
import {questionView} from '../src/control-plane/questions.js';
const base={id:'j',questionId:'q',status:'awaiting_clarification',originChatType:'group',originMessageId:'origin',originProfile:'a',senderId:'ou_author',result:{outcome:'needs_clarification',investigation:{status:'wait',blocker:{kind:'user_input',needed:'请确认统计时间'}}}};
const card={schema:'2.0',header:{template:'orange',title:{tag:'plain_text',content:'待补充'}},body:{elements:[{tag:'markdown',content:'需要统计时间'}]}};
test('input waits notify the actual author and preserve bot/thread without exposing requested values',()=>{
 const a=jobTerminalMention(base);assert.equal(a.kind,'clarification');assert.equal(a.replyTo,'origin');assert.equal(a.profile,'a');assert.match(a.text,/<at user_id="ou_author"><\/at>/);assert.doesNotMatch(a.text,/请确认统计时间/);
 assert.equal(jobTerminalMention({...base,originChatType:'p2p'}),null);
 for(const extra of [{modelCapacityWaiting:true},{environmentQuery:{}},{websiteQuery:{}},{sourceHistoryQuery:{}},{sourceEnvironmentQuery:{}},{environmentSetup:{}},...['unavailable','approval','login'].map(kind=>({investigation:{blocker:{kind}}}))])assert.equal(jobTerminalMention({...base,result:{...base.result,...extra}}),null);
 const partial=jobTerminalMention({...base,status:'completed',result:{...base.result,outcome:'partial'}});assert.equal(partial.kind,'clarification');
 const internal=jobTerminalMention({...base,status:'completed',result:{outcome:'partial',investigation:{blocker:{kind:'unavailable'}}}});assert.equal(internal.kind,undefined);assert.match(internal.text,/排查尚未完成/);
 assert.equal(jobTerminalMention({...base,senderId:'all'}),null);
});
test('same wait retains its key; subsequent input rounds and genuinely new requests have independent keys',()=>{
 const a=jobTerminalMention(base);assert.equal(jobTerminalMention({...base,updatedAt:'later'}).requestKey,a.requestKey);
 assert.notEqual(jobTerminalMention({...base,events:[{id:'new',type:'clarification_received'}]}).requestKey,a.requestKey);
 assert.notEqual(jobTerminalMention({...base,result:{...base.result,investigation:{blocker:{kind:'user_input',needed:'确认金额口径'}}}}).requestKey,a.requestKey);
});
async function fixture(t){
 const state={questions:{q:{id:'q',generation:1}},conversations:[],jobs:[structuredClone(base)],cardMessages:{}};
 const calls=[];let fail=true;const store={file:'/tmp/clarification-notice/state.json',read:async()=>structuredClone(state),transact:async f=>f(state)};
 const cards=new LiveCards(store,{replyCard:async()=>({message_id:'card'}),updateCard:async()=>{},reply:async(id,text,options)=>{calls.push({id,text,options});if(fail){fail=false;throw Error('network');}return {message_id:'notice'};}},{intervalMs:0});t.after(()=>cards.stop());
 const render=(mention=jobTerminalMention(base),generation=1,terminal=true)=>cards.upsert('question:q',card,{replyTo:'origin',profile:'a',replyInThread:true},{terminal,immediate:true,generation,terminalMention:mention});return {state,calls,cards,render};
}
test('actual waiting state can deliver after its card; retry and repeated rendering share one idempotency key',async t=>{
 const {state,calls,render}=await fixture(t);await assert.rejects(render(),/network/);await render();await render();assert.equal(calls.length,2);assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);assert.equal(calls[1].id,'origin');assert.equal(calls[1].options.profile,'a');assert.equal(calls[1].options.replyInThread,true);assert.equal(state.cardMessages['question:q'].mentionDelivered,true);
 state.jobs[0].status='completed';state.jobs[0].result={outcome:'ready'};await render(jobTerminalMention(state.jobs[0]));assert.equal(calls.length,3);assert.notEqual(calls[2].options.idempotencyKey,calls[1].options.idempotencyKey);assert.match(calls[2].text,/任务已结束/);
});
test('resumed or superseded jobs do not send a stale clarification',async t=>{
 for(const change of [s=>s.jobs[0].status='running',s=>s.jobs[0].result.modelCapacityWaiting=true,s=>s.jobs[0].result.investigation.blocker.needed='new request',s=>s.jobs.push({...base,id:'new',status:'completed',result:{outcome:'ready'}})]){
  const {state,calls,render}=await fixture(t);change(state);await render();assert.equal(calls.length,0);
 }
});
test('a private question never publishes the clarification in the group',async t=>{
 const {state,calls,cards}=await fixture(t);cards.feishu.sendPrivateCard=async()=>({message_id:'private',private_delivery_kind:'dm',chat_id:'dm'});cards.feishu.deletePrivateCard=async()=>{};
 await cards.upsert('question:q',card,{replyTo:'origin',profile:'a',chatId:'group',openId:'ou_author',visibility:'requester'},{terminal:true,immediate:true,generation:1,terminalMention:jobTerminalMention(base)});assert.equal(calls.length,0);assert.equal(state.cardMessages['question:q'].terminalMention,null);
});
test('question rendering addresses its original author even after an administrator supplies details',()=>{
 const at=new Date().toISOString(),root={id:'root',chatType:'group',senderId:'ou_author',profile:'a',status:'sent',createdAt:at},latest={...root,id:'admin',senderId:'ou_admin',outcome:{jobId:'j'}};
 const state={questions:{q:{id:'q',rootTurnId:'root',latestTurnId:'admin',senderId:'ou_author',messageId:'origin',profile:'a',projectId:'p',generation:2,createdAt:at,title:'调查'}},conversations:[root,latest],jobs:[{...base,senderId:'ou_admin',stage:'developer',createdAt:at,updatedAt:at,events:[]} ]};
 const view=questionView(state,'q');assert.match(view.mention.text,/ou_author/);assert.doesNotMatch(view.mention.text,/ou_admin/);
});
test('persisted wait retries after process reconstruction and a later input round gets its own reminder',async t=>{
 const {state,calls,cards,render}=await fixture(t);await assert.rejects(render(),/network/);await cards.stop();
 const store={file:'/tmp/clarification-restart/state.json',read:async()=>structuredClone(state),transact:async f=>f(state)};
 const restarted=new LiveCards(store,{replyCard:async()=>({message_id:'card'}),updateCard:async()=>{},reply:async(id,text,options)=>{calls.push({id,text,options});return {message_id:'next'};}},{intervalMs:0});t.after(()=>restarted.stop());
 await restarted.flush('question:q',true);assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);
 state.jobs[0].events=[{type:'clarification_received',id:'round2'}];const mention=jobTerminalMention(state.jobs[0]);await restarted.upsert('question:q',card,{replyTo:'origin',profile:'a',replyInThread:true},{terminal:true,immediate:true,generation:1,terminalMention:mention});assert.equal(calls.length,3);assert.notEqual(calls[1].options.idempotencyKey,calls[2].options.idempotencyKey);
});
test('normal recovery presentation clears an obsolete pending reminder without sending it',async t=>{
 const {state,calls,cards,render}=await fixture(t);await assert.rejects(render(),/network/);state.jobs[0].status='running';await cards.upsert('question:q',card,{replyTo:'origin',profile:'a',replyInThread:true},{terminal:true,immediate:true,generation:1,terminalMention:null});assert.equal(state.cardMessages['question:q'].terminalMention,null);assert.equal(calls.length,1);
});
