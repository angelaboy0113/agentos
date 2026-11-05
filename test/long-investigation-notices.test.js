import test from 'node:test';import assert from 'node:assert/strict';
import {LongInvestigationNotices,investigationElapsed,validateLongInvestigationNotice} from '../src/control-plane/long-investigation-notices.js';
const at=m=>new Date(Date.UTC(2026,10,5,0,m)).toISOString();
function fixture(){let now=Date.parse(at(34));const state={questions:{q:{id:'q',profile:'a',projectId:'one',chatId:'group',messageId:'origin',rootTurnId:'turn',latestTurnId:'turn'}},conversations:[{id:'turn',profile:'a',chatId:'group',chatType:'group',createdAt:at(0)}],jobs:[{id:'j',questionId:'q',projectId:'one',originProfile:'a',taskIntent:'analysis',status:'running',createdAt:at(0),updatedAt:at(34),events:[{type:'started',at:at(0)}]}]},calls=[];
 const context={projects:{humanIdentities:{maintainer:{a:'ou_adminA',b:'ou_adminB'}},longInvestigationNotice:{enabled:true,humanId:'maintainer',minutes:35,message:'老大，这个排查已经超过 {minutes} 分钟啦，快来看看 👀',since:at(0)}},store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},feishu:{reply:async(id,text,options)=>{calls.push({id,text,options});return{message_id:'notice'};}}};return {state,calls,context,setTime:m=>now=Date.parse(at(m)),service:()=>new LongInvestigationNotices(context,{now:()=>now})};}

test('35-minute notice never stops a task and persists one receipt across concurrent polls and restart',async()=>{
 const f=fixture(),service=f.service(),jobs=structuredClone(f.state.jobs);await service.retry();assert.equal(f.calls.length,0);f.setTime(35);await Promise.all([service.retry(),service.retry()]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,'origin');assert.match(f.calls[0].text,/ou_adminA.*35 分钟/);assert.equal(f.calls[0].options.replyInThread,true);f.setTime(90);await f.service().retry();assert.equal(f.calls.length,1);assert.deepEqual(f.state.jobs,jobs);await service.close();
});
test('active duration excludes human clarification and approval, unions parallel phases and includes model-capacity delay',()=>{
 const job={taskIntent:'analysis',createdAt:at(0),status:'running',updatedAt:at(60),events:[{type:'completed',at:at(10)},{type:'clarification_received',at:at(40)}]};assert.equal(investigationElapsed([job],at(0),Date.parse(at(60))),30*60000);
 const approval={...job,createdAt:at(0),events:[{type:'environment_approved',at:at(40)},{type:'started',at:at(41)}],environmentAccess:{approvalRequired:true}};assert.equal(investigationElapsed([approval],at(0),Date.parse(at(60))),20*60000);
 assert.equal(investigationElapsed([job,job],at(0),Date.parse(at(60))),30*60000);assert.equal(investigationElapsed([job],at(45),Date.parse(at(60))),15*60000);
 const capacity={...job,status:'awaiting_clarification',result:{modelCapacityWaiting:true},events:[{type:'completed',at:at(10),result:{modelCapacityWaiting:true}}]};assert.equal(investigationElapsed([capacity],at(0),Date.parse(at(60))),60*60000);
});
test('two systems and bot identities keep original thread and recipient separate; human waits and private tasks do not alert',async()=>{
 const f=fixture();f.setTime(36);f.state.questions.other={...f.state.questions.q,id:'other',profile:'b',projectId:'two',chatId:'another-group',messageId:'another-root',rootTurnId:'other-turn',latestTurnId:'other-turn'};f.state.conversations.push({id:'other-turn',profile:'b',chatId:'another-group',chatType:'group',createdAt:at(0)});f.state.jobs.push({...f.state.jobs[0],id:'other-job',questionId:'other',projectId:'two',originProfile:'b'});await f.service().retry();assert.equal(f.calls.length,2);assert.match(f.calls.find(c=>c.id==='another-root').text,/ou_adminB/);assert.doesNotMatch(f.calls.find(c=>c.id==='origin').text,/ou_adminB/);
 for(const change of [{visibility:'requester'},{status:'completed'},{status:'awaiting_approval'},{status:'awaiting_clarification'},{status:'cancelled'},{taskIntent:'implementation'}]){const g=fixture();g.setTime(90);Object.assign(g.state.jobs[0],change);await g.service().retry();assert.equal(g.calls.length,0);}
});
test('failed delivery reuses identical text and idempotency key; completion cancels pending reminder without replaying work',async()=>{
 const f=fixture();f.setTime(36);let fail=true;f.context.feishu.reply=async(id,text,options)=>{f.calls.push({id,text,options});if(fail)throw Error('offline');return{message_id:'sent'};};await f.service().retry();assert.equal(f.calls.length,1);fail=false;f.setTime(37);await f.service().retry();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.state.jobs[0].status,'running');
 const g=fixture();g.setTime(36);g.context.feishu.reply=async()=>{throw Error('offline');};await g.service().retry();g.state.jobs[0].status='completed';g.setTime(37);await g.service().retry();assert.equal(Object.values(g.state.longInvestigationNotices)[0].superseded,true);
});
test('new authenticated question turn has its own elapsed interval, not the previous users accumulated time',async()=>{
 const f=fixture();f.setTime(36);await f.service().retry();f.state.questions.q.latestTurnId='followup';f.state.conversations.push({id:'followup',profile:'a',chatId:'group',chatType:'group',createdAt:at(36)});f.setTime(60);await f.service().retry();assert.equal(f.calls.length,1);f.setTime(72);await f.service().retry();assert.equal(f.calls.length,2);
});
test('ambiguous retries beyond platform deduplication window pause only the optional notice, not investigation',async()=>{
 const f=fixture();f.setTime(36);f.context.feishu.reply=async()=>{throw Error('offline');};await f.service().retry();f.setTime(92);await f.service().retry();assert.equal(Object.values(f.state.longInvestigationNotices)[0].reconciliationRequired,true);assert.equal(f.state.jobs[0].status,'running');
 assert.throws(()=>validateLongInvestigationNotice({...f.context.projects.longInvestigationNotice,minutes:0},f.context.projects.humanIdentities));
});


test('missing or mismatched originating app identity never leaks a reminder to a different bot',async()=>{
 for(const change of [{profile:'b'},{chatId:'another'},{chatType:'p2p'}]){const f=fixture();f.setTime(36);Object.assign(f.state.conversations[0],change);await f.service().retry();assert.equal(f.calls.length,0);}
});
test('config roundtrip and retention preserve undelivered reminder dependencies',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {loadProjects}=await import('../src/control-plane/config.js');const {pruneHistory}=await import('../src/shared/retention.js');
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'long-notice-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'projects.json');await writeFile(file,JSON.stringify({...f.context.projects,projects:{}}));assert.deepEqual((await loadProjects(file)).longInvestigationNotice,f.context.projects.longInvestigationNotice);
 f.setTime(36);f.context.feishu.reply=async()=>{throw Error('offline');};await f.service().retry();f.state.jobs[0].status='completed';f.state.conversations[0].status='sent';pruneHistory(f.state,Date.parse(at(1000)));assert.ok(f.state.questions.q);assert.equal(Object.keys(f.state.longInvestigationNotices).length,1);
});
