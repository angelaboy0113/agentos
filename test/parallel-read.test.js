import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {parallelRead,prepareRepositoryLayers} from '../src/shared/parallel-read.js';
import {readBatchSpec,expandReadBatch} from '../src/runner/read-batch.js';
test('remote reads overlap with bounded concurrency and deterministic result order',async()=>{
 let active=0,peak=0;const result=await parallelRead([0,1,2,3,4,5],async value=>{peak=Math.max(peak,++active);await delay(5*(6-value));active--;return value;},{concurrency:3});
 assert.deepEqual(result,[0,1,2,3,4,5]);assert.equal(peak,3);assert.equal(active,0);
});
test('failed build drains workers before cleanup and does not schedule further work',async()=>{
 let finished=false;const started=[];
 await assert.rejects(parallelRead([0,1,2],async n=>{started.push(n);if(n===0){await delay(5);throw new Error('remote failure');}await delay(20);finished=true;},{concurrency:2}),/remote failure/);
 assert.equal(finished,true);assert.deepEqual(started,[0,1]);
});
test('root/nested repositories finish before children while independent siblings overlap',async()=>{
 const done=new Set(),running=new Set();let overlap=false;
 const repos=['.','a','b','a/nested'].map(path=>({path}));
 const result=await prepareRepositoryLayers(repos,async({path})=>{if(path!=='.')assert.ok(done.has('.'));if(path==='a/nested')assert.ok(done.has('a'));running.add(path);if(running.has('a')&&running.has('b'))overlap=true;await delay(5);running.delete(path);done.add(path);return path;});
 assert.deepEqual(result,repos.map(r=>r.path));assert.equal(overlap,true);
});
test('batch plans retain individual ordered calls; unavailable/write/dependent pseudo-tools are rejected before execution',()=>{
 const spec=[{tool:'count'},{tool:'schema'},{tool:'browser_click'}];assert.equal(readBatchSpec(spec).length,1);
 const choice={arguments:JSON.stringify({requests:[{tool:'count',arguments:{table:'items'}},{tool:'schema',arguments:{table:'items'}}]})};
 assert.deepEqual(expandReadBatch(choice,spec).map(x=>x.tool),['count','schema']);
 assert.throws(()=>expandReadBatch({arguments:JSON.stringify({requests:[{tool:'browser_click',arguments:{}}]})},spec));
 assert.throws(()=>expandReadBatch({arguments:JSON.stringify({requests:[{tool:'select',arguments:{}}]})},spec));
});
