import test from 'node:test';import assert from 'node:assert/strict';
import {retryModelCapacity} from '../src/shared/model-capacity.js';
import {CodexAppServer} from '../src/shared/codex-app-server.js';
test('capacity retries repeatedly without replaying successful model responses or tools',async()=>{
 let turns=0,tools=0;const events=[];const app=new CodexAppServer();app.child={};
 app.turnOnce=async p=>{assert.equal(p.threadId,'same');if(++turns<5)throw new Error('Selected model is at capacity.');return {text:'result'};};
 const r=await retryModelCapacity(()=>app.turnOnce({threadId:'same'}),{wait:async()=>{},onRetry:info=>events.push(info.attempt)});tools++;assert.equal(r.text,'result');assert.equal(turns,5);assert.equal(tools,1);assert.deepEqual(events,[1,2,3,4]);
});
test('abort during capacity wait stops retry before next model call',async()=>{
 const c=new AbortController();let calls=0;
 await assert.rejects(retryModelCapacity(async()=>{calls++;throw new Error('Selected model is at capacity.');},{signal:c.signal,onRetry:()=>c.abort()}),/aborted/);assert.equal(calls,1);
});
test('permission, capacity-like tool storage and uncertain transport errors are not replayed',async()=>{
 for(const message of ['permission denied','DATASET_CAPACITY: disk budget exceeded','network disconnected']){let calls=0;await assert.rejects(retryModelCapacity(async()=>{calls++;throw new Error(message);}),new RegExp(message));assert.equal(calls,1);}
});
test('closing app-server ends a capacity wait and does not restart the server',async()=>{
 const app=new CodexAppServer();app.child={};let calls=0;app.turnOnce=async()=>{calls++;app.child=null;throw new Error('Selected model is at capacity.');};await assert.rejects(app.turn({threadId:'same'}),/capacity/);assert.equal(calls,1);
});
test('actual app-server wrapper retries only model calls on the same thread before returning one decision',async()=>{
 const app=new CodexAppServer();app.child={};let calls=0;const events=[];
 app.turnOnce=async p=>{assert.equal(p.threadId,'original');if(++calls===1)throw new Error('Selected model is at capacity.');return {text:'one decision'};};
 const r=await app.turn({threadId:'original'},{onEvent:(kind,info)=>events.push([kind,info.reason])});assert.equal(r.text,'one decision');assert.equal(calls,2);assert.deepEqual(events,[['error','model_capacity']]);
});
