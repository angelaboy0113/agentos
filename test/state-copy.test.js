import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm,writeFile,rename}from'node:fs/promises';import os from'node:os';import path from'node:path';import{JsonStore}from'../src/shared/store.js';
test('JSON snapshot copies stay detached across concurrent reads, external replacement and failed transactions',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'state-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json'),store=new JsonStore(file);
 await store.transact(s=>{s.jobs=[{id:'j',status:'completed',result:{rows:[{id:'001',amount:'9007199254740993.01',empty:null}]},events:[]}];});
 const reads=await Promise.all(Array.from({length:5},()=>store.read()));for(const r of reads)assert.deepEqual(r,reads[0]);reads[0].jobs[0].result.rows[0].amount='corrupt';assert.equal(reads[1].jobs[0].result.rows[0].amount,'9007199254740993.01');assert.equal((await store.read()).jobs[0].result.rows[0].empty,null);assert.ok(store.readMetrics.jsonCopies>=5);
 await assert.rejects(store.transact(s=>{s.jobs[0].status='queued';throw Error('deliberate failure');}));assert.equal((await store.read()).jobs[0].status,'completed');
 const replacement=await store.read();replacement.jobs[0].status='blocked';await writeFile(file+'.new',JSON.stringify(replacement));await rename(file+'.new',file);assert.equal((await store.read()).jobs[0].status,'blocked');const selected=await store.select(s=>s.jobs[0].result);selected.rows[0].id='changed';assert.equal((await store.read()).jobs[0].result.rows[0].id,'001');
});
test('large histories copy through saved JSON without losing records or leaking returned references',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'state-history-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new JsonStore(path.join(dir,'state.json'));
 const history=Array.from({length:30000},(_,i)=>({id:'event-'+i,type:'progress',text:'Synthetic event '+i}));await store.transact(s=>{s.jobs=[{id:'a',events:history}];s.conversations=[{id:'chat',status:'completed'}];});
 const a=await store.read(),b=await store.read();assert.equal(a.jobs[0].events.length,30000);assert.deepEqual(a,b);a.jobs[0].events.pop();assert.equal((await store.read()).jobs[0].events.length,30000);assert.equal(store.readMetrics.jsonCopies,3);
});
