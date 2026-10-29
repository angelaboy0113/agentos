import test from 'node:test';
import assert from 'node:assert/strict';
import {git} from '../src/runner/source-sync.js';
import {classifySourceGitError,snapshotFailure,sourceGitError} from '../src/shared/source-git-diagnostic.js';
import {fetchSnapshotCommit} from '../src/runner/source-snapshot.js';
const failure=(stderr,extra={})=>Object.assign(new Error('private command https://name:password@example.invalid'),{stderr,code:128,...extra});
test('Git failure classification distinguishes credentials, remote, network, storage, objects and filters without retaining secrets',()=>{
 for(const [text,code] of [
  ['fatal: Authentication failed for https://secret:token@host','AUTH'],
  ["fatal: couldn't find remote ref refs/heads/prd",'REMOTE_UNAVAILABLE'],
  ['error: RPC failed; HTTP 503','NETWORK'],['fatal: unable to access URL: Connection reset by peer','NETWORK'],
  ['No space left on device','STORAGE'],['permission denied','PERMISSION'],
  ['fatal: bad object aabb','OBJECTS'],['fatal: smudge filter lfs failed','FILTER'],
  ['unknown failure with token=not-public','UNAVAILABLE'],
 ]){
  const d=classifySourceGitError(failure(text),'fetch');assert.equal(d.code,'SOURCE_GIT_'+code);
  const e=snapshotFailure({path:'service',branch:'production'},'检出固定提交',sourceGitError(d));
  assert.equal(e.sourceFailure.stage,'检出固定提交');assert.equal(e.sourceFailure.repository,'service');
  assert(!/secret|token|password|https:/.test(JSON.stringify(e)+e.message));
 }
 assert.equal(classifySourceGitError(failure('',{killed:true}),'fetch').code,'SOURCE_GIT_TIMEOUT');
});
test('temporary remote read failure recovers with unchanged arguments and reports progress; retries do not affect another call',async()=>{
 let calls=0;const seen=[],progress=[],waits=[];
 const value=await git('/cache',['fetch','origin','refs/heads/prd'],{execute:async(_bin,args)=>{
  seen.push(args);if(++calls<3)throw failure('Connection reset by peer');return {stdout:'ok\n'};
 },wait:async ms=>waits.push(ms),onRetry:d=>progress.push(d)});
 assert.equal(value,'ok');assert.equal(calls,3);assert.deepEqual(seen[0],seen[1]);assert.deepEqual(seen[1],seen[2]);
 assert.deepEqual(waits,[1000,2000]);assert.deepEqual(progress.map(d=>d.nextAttempt),[2,3]);
 const next=await git('/other-system',['ls-remote','origin','refs/heads/test'],{execute:async()=>({stdout:'other'})});assert.equal(next,'other');
});
test('retry exhaustion preserves error classification, operation and attempt count without raw stderr',async()=>{
 let calls=0;await assert.rejects(git('/cache',['ls-remote','origin','refs/heads/prd'],{
  execute:async()=>{calls++;throw failure('TLS error https://secret:token@host');},wait:async()=>{},
 }),e=>{assert.equal(e.sourceFailure.attempts,3);assert.equal(e.sourceFailure.operation,'ls-remote');assert.equal(e.code,'SOURCE_GIT_NETWORK');assert(!/secret|token|host/.test(JSON.stringify(e)+e.message));return true;});assert.equal(calls,3);
});
test('authentication, disk failure, unknown failure and non-read Git commands are never blindly replayed',async()=>{
 for(const [operation,error] of [['fetch',failure('Authentication failed')],['fetch',failure('No space left on device')],['fetch',failure('unknown')],['checkout',failure('',{killed:true})],['clone',failure('connection reset')],['repack',failure('connection reset')]]){
  let calls=0;await assert.rejects(git('/cache',[operation],{execute:async()=>{calls++;throw error;},wait:async()=>assert.fail('unexpected retry')}));assert.equal(calls,1);
 }
});
test('a moving branch fetches the initially observed commit and rejects a mismatched fixed object',async()=>{
 for(const fetched of ['first','other']){
  const seen=[];let reads=0,moved=0;
  const run=async(_cwd,args)=>{seen.push(args);if(args[0]==='rev-parse')return ++reads===1?'new-tip':fetched;return '';};
  const p=fetchSnapshotCommit('/temp',{branch:'prd',commit:'first'},'true',{onBranchMoved:async()=>moved++},run);
  if(fetched==='first')await p;else await assert.rejects(p,e=>e.code==='SOURCE_BRANCH_MOVED');
  assert.equal(moved,1);assert.deepEqual(seen.filter(a=>a[0]==='fetch').map(a=>a.at(-1)),['refs/heads/prd','first']);assert(!seen.some(a=>a[0]==='checkout'));
 }
});
test('unavailable pinned object retains the real authentication failure instead of claiming a branch race',async()=>{
 await assert.rejects(fetchSnapshotCommit('/temp',{branch:'prd',commit:'first'},'false',{},async(_cwd,args)=>{
  if(args[0]==='rev-parse')return 'moved';if(args.at(-1)==='first')throw sourceGitError({code:'SOURCE_GIT_AUTH',operation:'fetch',retryable:false,attempts:1});
 }),e=>e.code==='SOURCE_GIT_AUTH');
});
