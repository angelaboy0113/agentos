import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {MemoryAdmission,processTreeRss} from '../src/shared/memory-admission.js';
import {mainHeapMiB} from '../scripts/instance-memory.mjs';
import {createControlPlane} from '../src/control-plane/server.js';
import {createRunnerPool} from '../src/runner/index.js';
import {conversationCard,jobCard} from '../src/control-plane/message-cards.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<1000;i++){if(await fn())return;await delay(10);}throw Error('Test condition not reached');}
test('only the independent main launcher gets configured six-GiB startup flags',async()=>{
 assert.equal(mainHeapMiB(),6144);assert.equal(mainHeapMiB({mainHeapMiB:8192}),8192);
 for(const v of [0,-1,511,65537,NaN,'6144',null,3.5]){if(v===null)continue;assert.throws(()=>mainHeapMiB({mainHeapMiB:v}));}
 const shell=await readFile(new URL('../scripts/run-system-instance.sh',import.meta.url),'utf8');assert.match(shell,/--max-old-space-size="\$TASK_MAIN_HEAP_MIB"/);
 assert.match(await readFile(new URL('../src/runner/task-process.js',import.meta.url),'utf8'),/execArgv: \[\]/);
});
test('heap and process-tree pressure use hysteresis and retain active jobs without cancellation',async()=>{
 const m={heapUsed:100,heapLimit:1000,rss:200},g=new MemoryAdmission({sample:()=>m,treeBudgetMiB:256,treeSample:async()=>0});
 assert.equal(g.check().allowed,true);m.heapUsed=750;assert.equal(g.check().allowed,false);m.heapUsed=650;assert.equal(g.check().allowed,false);m.heapUsed=600;assert.equal(g.check().allowed,true);
 g.treeSample=async()=>256*1048576;await g.refresh();assert.equal(g.check().allowed,false);g.treeSample=async()=>220*1048576;await g.refresh();assert.equal(g.check().allowed,false);g.treeSample=async()=>200*1048576;await g.refresh();assert.equal(g.check().allowed,true);
 g.treeSample=async()=>{throw Error('synthetic unavailable');};await g.refresh();assert.equal(g.check().treeSampleUnavailable,true);m.heapUsed=800;assert.equal(g.check().allowed,false);
 assert.equal(g.check().peakHeapBytes,800);assert.throws(()=>new MemoryAdmission({treeBudgetMiB:0}));
});
test('tree sampler measures only owned hierarchy without process arguments',{skip:!['darwin','linux'].includes(process.platform)},async()=>{assert.ok(await processTreeRss()>0);});
async function setup(t,gate,responder){
 const dir=await mkdtemp(path.join(os.tmpdir(),'memory-admit-'));const replies=[];
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'state.json'),projectsFile:path.join(dir,'projects.json'),adminToken:'synthetic-admin',runnerToken:'synthetic-runner',runnerConcurrency:6,projects:{projects:{one:{repoPath:dir},two:{repoPath:dir}},chatProjectMap:{one:'one',two:'two'}},agents:{agents:{}},feishuClient:{reply:async(id,text,opts)=>{replies.push({id,text,opts});return{data:{message_id:'om_'+id}};}},memoryAdmission:gate,conversationResponder:responder??(async()=>({reply:'synthetic',action:'reply',intent:'none',instruction:'',jobId:'',projectId:'',attachmentIds:[]})),conversationOptions:{concurrency:3,feedbackMs:0}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.conversations.stop();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
 return{app,replies,dir,url:'http://127.0.0.1:'+app.server.address().port};
}
test('twenty simultaneous jobs use six real Runner slots, pressure waits then resumes all with preserved scope',async t=>{
 let allow=true;const gate={check:()=>({allowed:allow})};const{app,url}=await setup(t,gate);
 for(let i=0;i<20;i++)await app.store.createJob({id:'load-'+i,projectId:i%2?'one':'two',chatId:'chat-'+i,senderId:'sender-'+i,agentProfile:'bot-'+i%4,stage:'developer',workflow:'single_developer',taskIntent:'analysis',instruction:'synthetic '+i,sourceEnvironment:i%2?'prd':'sit'});
 let running=0,peak=0,started=0;const holds=[];
 const pool=createRunnerPool({serverUrl:url,runnerToken:'synthetic-runner',runnerId:'stress',concurrency:6,pollMs:5,executor:'mock',projects:{}},async job=>{running++;peak=Math.max(peak,running);started++;await new Promise(r=>holds.push(r));running--;return{outcome:'ready',finalMessage:'Synthetic scope '+job.projectId+'/'+job.sourceEnvironment};});
 const all=pool.map(r=>r.start());t.after(async()=>{pool.forEach(r=>r.stop());while(holds.length)holds.shift()();await Promise.all(all);});
 await until(()=>started===6);assert.equal(peak,6);assert.equal((await app.store.select(s=>s.jobs.filter(j=>j.status==='queued').length)),14);
 allow=false;while(holds.length)holds.shift()();await until(()=>running===0);await delay(50);assert.equal(started,6);assert.equal((await app.store.select(s=>s.jobs.filter(j=>j.status==='queued').length)),14);
 allow=true;const pump=setInterval(()=>{while(holds.length)holds.shift()();},10);
 try{await until(async()=>await app.store.select(s=>s.jobs.every(j=>j.status==='completed')));}finally{clearInterval(pump);}
 pool.forEach(r=>r.stop());await Promise.all(all);assert.equal(started,20);assert.equal(peak,6);
 const jobs=await app.store.select(s=>s.jobs);assert.equal(new Set(jobs.map(j=>j.id)).size,20);assert.ok(jobs.every(j=>j.result.finalMessage.includes(j.projectId+'/'+j.sourceEnvironment)));assert.equal(jobs.filter(j=>j.status==='failed'||j.status==='cancelled').length,0);
});
test('twenty queued intake turns keep three model slots and recover after pressure with one scoped wait receipt',async t=>{
 let allow=false,active=0,peak=0,count=0;const gate={check:()=>({allowed:allow})};
 const{app,replies}=await setup(t,gate,async()=>{active++;peak=Math.max(peak,active);await delay(20);active--;count++;return{reply:'回答',action:'reply',intent:'none',instruction:'',jobId:'',projectId:'',attachmentIds:[]};});
 app.conversations.context.reception.enabled=true;
 const results=await Promise.all(Array.from({length:20},(_,i)=>app.conversations.enqueue({message_id:'input-'+i,chat_id:i%2?'one':'two',sender_id:'sender-'+i,agent_profile:'bot-'+i%4,chat_type:'group',content:'synthetic',root_id:'root-'+i})));
 await until(()=>replies.length===20);assert.equal(count,0);assert.equal((await app.store.select(s=>s.conversations.filter(c=>c.status==='queued').length)),20);
 const first=results[0].turnId;await app.conversations.sendQueueReceipt(first);assert.equal(replies.length,20);assert.ok(replies.every(r=>r.opts.idempotencyKey.startsWith('queue-')&&r.text.includes('等待')));
 allow=true;app.conversations.wake();await until(()=>count===20);await app.conversations.idle();assert.equal(peak,3);assert.equal(replies.filter(r=>r.text.includes('等待')).length,20);assert.equal((await app.store.select(s=>s.conversations.filter(c=>c.status==='sent').length)),20);
});
test('queue presentation is waiting not success, does not claim another user owns the queue',()=>{
 const card=JSON.stringify(conversationCard({status:'queued',createdAt:new Date().toISOString()}));assert.match(card,/等待可用处理位置/);assert.doesNotMatch(card,/同一会话前面/);assert.match(JSON.stringify(jobCard({id:'j',status:'queued',taskIntent:'analysis',stage:'developer',events:[],createdAt:new Date().toISOString()})),/等待可用调查位置/);
});

test('pressure leaves ready results deliverable and failed wait receipts reuse their key',async t=>{
 let allow=false;const{app,replies}=await setup(t,{check:()=>({allowed:allow})});app.conversations.feedbackMs=100000;app.conversations.context.reception.enabled=true;
 const saved=await app.conversations.enqueue({message_id:'retry',chat_id:'one',sender_id:'asker',agent_profile:'bot',chat_type:'group',content:'synthetic'});
 let calls=0,keys=[];const reply=app.conversations.context.feishu.reply;app.conversations.context.feishu.reply=async(id,text,o)=>{keys.push(o.idempotencyKey);if(++calls===1)throw Error('synthetic delivery failure');return reply(id,text,o);};
 await assert.rejects(app.conversations.sendQueueReceipt(saved.turnId));await app.conversations.sendQueueReceipt(saved.turnId);assert.equal(keys[0],keys[1]);assert.equal(replies.length,1);
 await app.conversations.update(saved.turnId,{status:'ready',response:'already verified answer'});app.conversations.wake();await until(async()=>await app.store.select(s=>s.conversations[0].status==='sent'));assert.equal(allow,false);assert.equal(replies.length,2);
});

test('parallel lease requests cannot bypass the instance-wide Runner ceiling',async t=>{
 const{app}=await setup(t,{check:()=>({allowed:true})});
 for(let i=0;i<20;i++)await app.store.createJob({stage:'developer',workflow:'single_developer',projectId:'one',instruction:'synthetic'});
 const leased=await Promise.all(Array.from({length:20},(_,i)=>app.store.leaseNext('remote-'+i,[],120,{maxRunning:6})));assert.equal(leased.filter(Boolean).length,6);assert.equal((await app.store.select(s=>s.jobs.filter(j=>j.status==='queued').length)),14);
 await app.store.transact(s=>{s.jobs.find(j=>j.status==='running').status='cancelling';});assert.equal(await app.store.leaseNext('extra',[],120,{maxRunning:6}),null);
});
