import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,link,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {syncSnapshot,verifySnapshot,prepareSnapshotHistory,restoreSnapshot} from '../src/runner/source-snapshot.js';
import {prepareAnalysisSources} from '../src/runner/source-sync.js';
import {pruneSourceSnapshots,snapshotReferences} from '../src/shared/source-snapshot-gc.js';
import {runWithSourceHistory} from '../src/runner/source-history-runner.js';
import {JsonStore} from '../src/shared/store.js';
const exec=promisify(execFile),git=async(cwd,...args)=>(await exec('git',['-C',cwd,...args])).stdout.trim();
async function fixture(t,id='system-a',environment='qa-custom'){
 const base=await mkdtemp(path.join(os.tmpdir(),'pinned-history-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const origin=path.join(base,'origin.git'),writer=path.join(base,'writer'),source=path.join(base,'source'),repo=path.join(source,'service');await mkdir(writer);await mkdir(source);await git(base,'init','--bare',origin);await git(writer,'init','-b','business');
 const commit=async value=>{await writeFile(path.join(writer,'rule.txt'),value);await git(writer,'add','.');await git(writer,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',value);await git(writer,'push','origin','business');};
 await git(writer,'remote','add','origin',origin);await commit('first');await commit('second');await git(base,'clone','--no-local','--depth=1','--branch','business',origin,repo);
 const project={id,repoPath:source,analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(base,'cache'),analysisEnvironments:{[environment]:{repositories:[{path:'service',branch:'business'}]}}};
 return {base,origin,writer,source,repo,project,environment,commit};
}
test('fetch errors after publishing complete ancestry retain diagnostics but independently validate the fixed cache',async t=>{
 const f=await fixture(t),report=await syncSnapshot(f.project,f.environment),cwd=path.join(report.workspace,'service');
 const result=await prepareSnapshotHistory(f.project,report,{fetchHistory:async(dir,args)=>{await git(dir,...args);throw Object.assign(Error('synthetic post-fetch process failure'),{code:'SOURCE_GIT_UNAVAILABLE'});}});
 assert.equal(result.repositories[0].status,'complete');assert.equal(result.repositories[0].commits,2);assert.equal(result.repositories[0].fetchDiagnostic.code,'SOURCE_GIT_UNAVAILABLE');
 await verifySnapshot(f.project,report);assert.equal(await git(cwd,'rev-parse','HEAD'),report.repositories[0].commit);
 const reused=await prepareSnapshotHistory(f.project,report,{fetchHistory:()=>assert.fail('complete history must be reused')});assert.equal(reused.repositories[0].reused,true);
});
test('two systems and arbitrary environments hydrate pinned ancestors concurrently without selecting a newer tip',async t=>{
 const [a,b]=await Promise.all([fixture(t,'tpm','uat'),fixture(t,'ltx','sit')]);
 for(const f of [a,b]){
  const report=await syncSnapshot(f.project,f.environment),cwd=path.join(report.workspace,'service'),file=path.join(path.dirname(report.workspace),'source-manifest.json'),before=await readFile(file);
  await f.commit('newer remote');const out=await Promise.all([prepareSnapshotHistory(f.project,report,{repositories:['service']}),prepareSnapshotHistory(f.project,report,{repositories:['service']})]);
  assert.ok(out.every(r=>r.repositories[0].status==='complete'));assert.equal(await git(cwd,'rev-list','--count','HEAD'),'2');assert.equal(await git(cwd,'show','HEAD~1:rule.txt'),'first');assert.equal(await git(cwd,'rev-parse','HEAD'),report.repositories[0].commit);assert.deepEqual(await readFile(file),before);assert.equal(await readFile(path.join(cwd,'rule.txt'),'utf8'),'second');await verifySnapshot(f.project,report);
  assert.equal((await git(cwd,'log','--format=%s','HEAD')).split('\n').length,2);assert.match(await git(cwd,'blame','HEAD','--','rule.txt'),/second/);const difference=await git(cwd,'diff','HEAD~1','HEAD','--','rule.txt');assert.match(difference,/^-first$/m);assert.match(difference,/^\+second$/m);
  await rm(f.origin,{recursive:true});await rm(f.source,{recursive:true});assert.equal((await prepareSnapshotHistory(f.project,report)).repositories[0].status,'complete');
 }
});
test('history failure preserves current source, classifies missing origin, and rejects wrong repositories or environment switches',async t=>{
 const f=await fixture(t),report=await syncSnapshot(f.project,f.environment),cwd=path.join(report.workspace,'service');await rm(f.origin,{recursive:true});
 const failure=await prepareSnapshotHistory(f.project,report);assert.equal(failure.repositories[0].status,'unavailable');assert.match(failure.repositories[0].reason,/Git 操作失败/);await verifySnapshot(f.project,report);assert.equal(await readFile(path.join(cwd,'rule.txt'),'utf8'),'second');
 await assert.rejects(prepareSnapshotHistory(f.project,report,{repositories:['../outside']}),/当前问题/);
 await assert.rejects(prepareAnalysisSources({stage:'developer',sourceEnvironment:'another',analysisSourceSnapshot:report},f.project),/不能切换/);
});
test('Git metadata links, alternate stores, commondir and worktree redirection are rejected before writing outside cache',async t=>{
 const f=await fixture(t),report=await syncSnapshot(f.project,f.environment),root=path.join(report.workspace,'service/.git'),outside=path.join(f.base,'sentinel');await writeFile(outside,'keep');
 for(const name of ['commondir','objects/info/alternates','objects/info/http-alternates']){
  await writeFile(path.join(root,name),f.repo+'\n');await assert.rejects(prepareSnapshotHistory(f.project,report),/共享对象库|worktree|外部 Git/);await rm(path.join(root,name));
 }
 await symlink(outside,path.join(root,'unsafe-link'));await assert.rejects(prepareSnapshotHistory(f.project,report),/符号链接/);await rm(path.join(root,'unsafe-link'));
 await link(outside,path.join(root,'unsafe-hardlink'));await assert.rejects(prepareSnapshotHistory(f.project,report),/硬链接/);await rm(path.join(root,'unsafe-hardlink'));
 assert.equal(await readFile(outside,'utf8'),'keep');await verifySnapshot(f.project,report);
});
test('old metadata-free provenance remains readable, and reclaimed caches restore the exact old commit',async t=>{
 const f=await fixture(t),a=await syncSnapshot(f.project,f.environment);delete a.projectId;delete a.repositorySources;const {remoteCheckedAt,...manifest}=a;await writeFile(path.join(path.dirname(a.workspace),'source-manifest.json'),JSON.stringify(manifest));await verifySnapshot(f.project,a);
 await f.commit('third');const b=await syncSnapshot(f.project,f.environment);let state={jobs:[]};let projected=0;const gc=()=>pruneSourceSnapshots(f.project,{getState:async()=>{throw Error('Full history copy forbidden');},readReferences:async(p,root,ids)=>{projected++;return structuredClone(snapshotReferences(state,p,root,ids));},withState:fn=>fn(state),apply:true});
 const removed=await gc();assert.ok(projected>=2);assert.equal(removed.removed.length,1);await assert.rejects(access(a.workspace));const audit=JSON.parse(await readFile(path.join(f.project.analysisSnapshotRoot,'.snapshot-audit',path.basename(path.dirname(a.workspace))+'.json')));assert.equal(audit.status,'deleted');assert.deepEqual(audit.manifest,manifest);
 const restored=await restoreSnapshot(f.project,a);assert.equal(restored.workspace,a.workspace);assert.equal(await readFile(path.join(a.workspace,'service/rule.txt'),'utf8'),'second');await verifySnapshot(f.project,a);await access(b.workspace);
});
test('GC observes the authoritative latest writer state and protects partial multi-part delivery and unsent mentions',async t=>{
 const f=await fixture(t),a=await syncSnapshot(f.project,f.environment);await f.commit('third');await syncSnapshot(f.project,f.environment);
 const baseJob={id:'old-job',questionId:'q',projectId:f.project.id,status:'completed',result:{sourceSync:a}};let state={jobs:[baseJob],cardMessages:{'question:q':{revision:1,deliveredRevision:1,terminalMention:{},mentionDelivered:false}}};
 let result=await pruneSourceSnapshots(f.project,{getState:async()=>state});assert.equal(result.removed.length,0);
 state.cardMessages={};state.reportDeliveries={one:{sourceJobId:'old-job',questionId:'q',messageId:'part-one',parts:[{messageId:'part-one'},{}]}};
 result=await pruneSourceSnapshots(f.project,{getState:async()=>state});assert.equal(result.removed.length,0);
 state.reportDeliveries={};result=await pruneSourceSnapshots(f.project,{getState:async()=>state,apply:true,withState:fn=>{state.jobs.push({...baseJob,id:'late-job',status:'running',analysisSourceSnapshot:a});return fn(state);}});assert.equal(result.removed.length,0);assert.ok(result.kept.some(x=>x.reason==='became-active-before-delete'));await access(a.workspace);
});
test('source pin survives store reopen and refuses cross-question continuation or replacement',async t=>{
 const f=await fixture(t),store=new JsonStore(path.join(f.base,'state.json'));const {job}=await store.createJob({projectId:'p',taskIntent:'analysis',stage:'developer',instruction:'read',questionId:'q'});const leased=await store.leaseNext('runner'),identity={runnerId:'runner',leaseId:leased.lease.id};const proof={policy:'isolated-environment-source-v1',workspace:'/fixed',environment:'sit',repositories:[]};
 await store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:proof});const reopened=new JsonStore(path.join(f.base,'state.json'));assert.deepEqual((await reopened.getJob(job.id)).analysisSourceSnapshot,proof);
 await assert.rejects(reopened.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:{...proof,workspace:'/new'}}),/不能替换/);
 await assert.rejects(reopened.appendEvent(job.id,{type:'progress',...identity,sourceContinuation:{questionId:'other',workspace:'/fixed',threadId:'thread'}}),/身份不匹配/);
});
test('history requests resume the same thread once ready, never replay business work, and stop identical no-progress requests',async()=>{
 const sourceSync={policy:'isolated-environment-source-v1',repositories:[{path:'service'}]},events=[],calls=[];let turns=0,historyCalls=0;
 const options={job:{taskIntent:'analysis',questionId:'q',stage:'developer'},sourceSync,project:{},workspace:'/fixed',emit:async x=>events.push(x)};
 const result=await runWithSourceHistory(options,{history:async()=>{historyCalls++;return {repositories:[{path:'service',status:'complete'}]};},run:async o=>{calls.push(o);return ++turns===1?{threadId:'same-thread',sourceHistoryQuery:{repositories:['service'],reason:'rule introduced'},finalMessage:'current evidence'}:{outcome:'ready',sourceHistoryQuery:null,finalMessage:'history verified'};}});
 assert.equal(result.outcome,'ready');assert.equal(historyCalls,1);assert.equal(calls[1].resumeThreadIdOverride,'same-thread');assert.ok(events.some(x=>x.sourceContinuation?.threadId==='same-thread'));
 const repeat=await runWithSourceHistory(options,{history:async()=>({repositories:[{status:'unavailable'}]}),run:async()=>({sourceHistoryQuery:{repositories:['service'],reason:'unchanged'},finalMessage:'source remains',threadId:'same'})});assert.equal(repeat.outcome,'blocked');assert.match(repeat.finalMessage,/source remains/);
});

test('different production revision targets never trigger irrelevant pinned-ancestor downloads',async()=>{let calls=0;const pin='a'.repeat(40),target='b'.repeat(40),options={job:{taskIntent:'analysis',questionId:'q',stage:'developer'},project:{},sourceSync:{policy:'isolated-environment-source-v1',environment:'prd',repositories:[{path:'service',commit:pin}]},emit:async()=>{}};const result=await runWithSourceHistory(options,{history:async()=>assert.fail('must not download unrelated ancestry'),run:async o=>{calls++;if(calls===1)return{threadId:'same',sourceHistoryQuery:{repositories:['service'],targets:[{repository:'service',commit:target}],reason:'compare deployed version'},finalMessage:'current source retained'};assert.match(o.prompt,/SOURCE_HISTORY_TARGET_MISMATCH/);return{outcome:'partial',sourceHistoryQuery:null,finalMessage:'precise version scope remains missing'};}});assert.equal(result.outcome,'partial');assert.equal(result.sourceHistory.repositories[0].requestedCommit,target);assert.equal(calls,2);});
test('legacy free-text deployed SHA is preflighted instead of triggering unrelated ancestry fetch',async()=>{let n=0;const options={job:{taskIntent:'analysis',questionId:'q',stage:'developer'},project:{},sourceSync:{policy:'isolated-environment-source-v1',environment:'prd',repositories:[{path:'service',commit:'a'.repeat(40)}]},emit:async()=>{}};const result=await runWithSourceHistory(options,{history:async()=>assert.fail('legacy target is ambiguous'),run:async o=>++n===1?{threadId:'same',sourceHistoryQuery:{repositories:['service'],reason:'production prd-other@'+'b'.repeat(40)},finalMessage:'keep evidence'}:{outcome:'partial',sourceHistoryQuery:null,finalMessage:'explicit missing version'}});assert.equal(result.sourceHistory.repositories[0].code,'SOURCE_HISTORY_TARGET_UNSPECIFIED');assert.equal(n,2);});
