import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {requestedSourceEnvironments,comparisonTarget,requireComparisonContinuation} from '../src/shared/source-comparison.js';
import {JsonStore} from '../src/shared/store.js';import {AgentRunner} from '../src/runner/index.js';import {analysisThreadId} from '../src/runner/codex-executor.js';import {prepareAnalysisSources} from '../src/runner/source-sync.js';import {criticalControl} from '../src/shared/control-receipts.js';
const project={analysisSourceMode:'isolated',defaultSourceEnvironment:'sit',analysisEnvironments:{sit:{},prd:{}}};
test('explicit original dual environment request permits only unambiguous registered tiers',()=>{
 for(const text of ['看下测试机和生产机，货需保存哪里','Compare SIT and PRD source and table mapping','核对测试环境、生产环境的定时任务'])assert.deepEqual(requestedSourceEnvironments({sourceEnvironment:'sit',originalQuestion:text},project),['sit','prd']);
 for(const text of ['仅查SIT，不查PRD','查测试环境，不要生产','check test not prod','生产查询','SIT接口名字是prod，并不要求访问生产','测试不涉及，请看生产'])assert.deepEqual(requestedSourceEnvironments({sourceEnvironment:'sit',originalQuestion:text},project),['sit']);
 assert.deepEqual(requestedSourceEnvironments({sourceEnvironment:'sit',originalQuestion:'查测试环境',instruction:'同时检查PRD',context:[{result:{summary:'SIT PRD'}}]},project),['sit']);
 assert.deepEqual(requestedSourceEnvironments({sourceEnvironment:'sit',originalQuestion:'比较SIT和PRD'},{...project,analysisEnvironments:{sit:{},other:{runtimeTier:'uat'},prd:{}}}),['sit']);
 assert.throws(()=>comparisonTarget({sourceEnvironment:'sit',originalQuestion:'查测试'},project,{environmentId:'prd',reason:'模型想切换'}));
});
async function pinned(t){const dir=await mkdtemp(path.join(os.tmpdir(),'comparison-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new JsonStore(path.join(dir,'state.json'));const {job}=await store.createJob({projectId:'p',questionId:'q',taskIntent:'analysis',continuousInvestigation:true,stage:'developer',sourceEnvironment:'sit',instruction:'比较SIT和PRD',originProfile:'bot',chatId:'group'});const leased=await store.leaseNext('runner'),identity={runnerId:'runner',leaseId:leased.lease.id};return {dir,store,job,identity};}
const snapshot=env=>({policy:'isolated-environment-source-v1',cacheKey:env+'-fixed',environment:env,workspace:'/immutable/'+env,repositories:[{path:'service',branch:env,commit:env+'-sha'}]});
const result=(job,env)=>({outcome:'needs_clarification',workspace:snapshot(env).workspace,sourceSync:snapshot(env),sourceQuestionId:job.questionId,handoffGate:{passed:true},threadId:'thread-'+env,summary:env+' verified rules',verifiedArtifacts:[{kind:'code',path:'service/Rule.java'}]});
test('same job pins per environment, persists across restart and restores independent source threads',async t=>{
 const {dir,store,job,identity}=await pinned(t);await store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:snapshot('sit')});
 let j=await store.switchContinuousSourceEnvironment(job.id,identity,result(job,'sit'),{environmentId:'prd',reason:'核对生产差异'},project);assert.equal(j.analysisSourceSnapshot,undefined);assert.equal(j.environmentAccess,undefined);
 await store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:snapshot('prd')});const reopened=new JsonStore(path.join(dir,'state.json'));
 j=await reopened.switchContinuousSourceEnvironment(job.id,identity,result(job,'prd'),{environmentId:'sit',reason:'核对剩余测试证据'},project);assert.equal(j.analysisSourceSnapshot.cacheKey,'sit-fixed');assert.equal(j.sourceEnvironmentEvidence.prd.summary,'prd verified rules');assert.equal(analysisThreadId(j,'/immutable/sit'),'thread-sit');assert.equal(analysisThreadId({...j,sourceEnvironment:'prd'},'/immutable/prd'),'thread-prd');
 await assert.rejects(reopened.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:{...snapshot('sit'),cacheKey:'new'}}),/不能替换/);
 await assert.rejects(reopened.switchContinuousSourceEnvironment(job.id,{...identity,leaseId:'foreign'},result(job,'sit'),{environmentId:'prd',reason:'again'},project),/租约/);
 await assert.rejects(reopened.switchContinuousSourceEnvironment(job.id,identity,{...result(job,'sit'),sourceQuestionId:'other'}, {environmentId:'prd',reason:'bad question'},project),/本问题/);
});
test('source handoff requires actual active snapshot and passed gate, never grants DB access',async t=>{
 const {store,job,identity}=await pinned(t);await assert.rejects(store.switchContinuousSourceEnvironment(job.id,identity,result(job,'sit'),{environmentId:'prd',reason:'next'},project),/固定源码/);
 await store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:snapshot('sit')});await assert.rejects(store.switchContinuousSourceEnvironment(job.id,identity,{...result(job,'sit'),handoffGate:{passed:false}},{environmentId:'prd',reason:'next'},project),/不能接续/);
 await assert.rejects(store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:snapshot('prd')}),/环境不一致/);
});
test('a premature ready answer must continue missing environment instead of claiming both checked',()=>{
 const job={continuousInvestigation:true,taskIntent:'analysis',stage:'developer',sourceEnvironment:'sit',originalQuestion:'比较SIT和PRD'},ready={outcome:'ready',investigation:{status:'complete',goals:[{id:'original-question',status:'verified'}]}};
 const r=requireComparisonContinuation(job,project,ready);assert.equal(r.outcome,'needs_clarification');assert.equal(r.sourceEnvironmentQuery.environmentId,'prd');assert.equal(r.investigation.goals[0].status,'open');assert.equal(r.environmentQuery,null);
 assert.equal(requireComparisonContinuation({...job,sourceEnvironment:'prd',sourceEnvironmentEvidence:{sit:{summary:'verified'}}},project,ready),ready);
 assert.equal(requireComparisonContinuation({...job,originalQuestion:'SIT'},project,ready),ready);
 assert.ok(criticalControl('/api/v1/jobs/j/continuous-source',{}));
});
test('runner continues source environments under same lease and original question without user resubmission',async()=>{
 let calls=0;const root={id:'job',questionId:'q',taskIntent:'analysis',continuousInvestigation:true,stage:'developer',sourceEnvironment:'sit',lease:{id:'lease'}};
 const runner=new AgentRunner({runnerId:'runner'},async j=>{calls++;return j.sourceEnvironment==='sit'?{outcome:'needs_clarification',sourceEnvironmentQuery:{environmentId:'prd',reason:'compare'}}:{outcome:'ready',finalMessage:'separate verified results'};});
 runner.post=async(url,body)=>{assert.match(url,/continuous-source$/);assert.equal(body.leaseId,'lease');return {job:{...root,sourceEnvironment:'prd'}};};
 const answer=await runner.continueInvestigation(root,async()=>{},new AbortController().signal,()=>{});assert.equal(calls,2);assert.equal(answer.outcome,'ready');
});
test('real branches keep two immutable source snapshots across new remote commit and environment return',async t=>{
 const execute=promisify(execFile),g=async(cwd,...args)=>(await execute('git',['-C',cwd,...args])).stdout.trim(),dir=await mkdtemp(path.join(os.tmpdir(),'comparison-git-'));t.after(()=>rm(dir,{recursive:true,force:true}));const writer=path.join(dir,'writer'),source=path.join(dir,'source'),origin=path.join(dir,'origin.git');await mkdir(writer);await mkdir(source);await g(dir,'init','--bare',origin);await g(writer,'init','-b','sit');await g(writer,'remote','add','origin',origin);
 const commit=async text=>{await writeFile(path.join(writer,'Rule.java'),text);await g(writer,'add','.');await g(writer,'-c','user.name=Test','-c','user.email=t@example.invalid','commit','-m',text);};await commit('test-rule');await g(writer,'push','origin','sit');await g(writer,'checkout','-b','prd');await commit('production-rule');await g(writer,'push','origin','prd');await g(dir,'clone',origin,path.join(source,'service'));
 const p={...project,id:'p',repoPath:source,analysisSnapshotRoot:path.join(dir,'cache'),analysisEnvironments:{sit:{repositories:[{path:'service',branch:'sit'}]},prd:{repositories:[{path:'service',branch:'prd'}]}}};
 const a=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'sit'},p),b=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'prd',context:[{result:{sourceSync:a}}]},p);assert.notEqual(a.workspace,b.workspace);assert.notEqual(a.repositories[0].commit,b.repositories[0].commit);
 await commit('production-new');await g(writer,'push','origin','prd');const returned=await prepareAnalysisSources({questionId:'q',analysisSourceQuestionId:'q',stage:'developer',sourceEnvironment:'prd',analysisSourceSnapshots:{sit:a,prd:b}},p);assert.equal(returned.repositories[0].commit,b.repositories[0].commit);assert.equal(await g(path.join(a.workspace,'service'),'show','HEAD:Rule.java'),'test-rule');
});
test('concurrent systems in one state preserve independent environment pins, profile and question ownership',async t=>{
 const {store,job,identity}=await pinned(t),second=(await store.createJob({projectId:'other-system',questionId:'other-question',taskIntent:'analysis',continuousInvestigation:true,stage:'developer',sourceEnvironment:'sit',instruction:'比较SIT和PRD',originProfile:'other-bot',chatId:'other-group'})).job;
 const leased=await store.leaseNext('other-runner'),secondIdentity={runnerId:'other-runner',leaseId:leased.lease.id},otherProof={...snapshot('sit'),cacheKey:'other-system-fixed',workspace:'/other-system/sit'};assert.equal(leased.id,second.id);
 await Promise.all([store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:snapshot('sit')}),store.appendEvent(second.id,{type:'progress',...secondIdentity,sourceSnapshot:otherProof})]);
 await Promise.all([store.switchContinuousSourceEnvironment(job.id,identity,result(job,'sit'),{environmentId:'prd',reason:'compare one'},project),store.switchContinuousSourceEnvironment(second.id,secondIdentity,{...result(second,'sit'),sourceSync:otherProof,workspace:otherProof.workspace},{environmentId:'prd',reason:'compare two'},project)]);
 const a=await store.getJob(job.id),b=await store.getJob(second.id);assert.equal(a.sourceEnvironmentEvidence.sit.workspace,'/immutable/sit');assert.equal(b.sourceEnvironmentEvidence.sit.workspace,'/other-system/sit');assert.equal(b.originProfile,'other-bot');assert.equal(b.chatId,'other-group');assert.equal(a.sourceEnvironmentEvidence.prd,undefined);
});
