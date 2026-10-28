import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {buildSourceQueryContext,sourceQueryTools} from '../src/runner/source-query-context.js';
import {environmentContinuation} from '../src/shared/investigation-review.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'agentos-source-query-'));t.after(()=>rm(root,{recursive:true,force:true}));const text='<mapper>\nSELECT customer_id,SUM(amount) FROM actual_amount WHERE year_month &lt;= 202609\n</mapper>';await writeFile(path.join(root,'Mapper.xml'),text);return {root,text,result:{workspace:root,sourceSync:{workspace:root},handoffGate:{passed:true},verifiedArtifacts:[{kind:'code',path:'Mapper.xml',sha256:sha(text),bytes:Buffer.byteLength(text)}]}};}
test('verified source bodies, exact lines and checksums reach the DB planner without allowing arbitrary file reads',async t=>{
 const f=await fixture(t),context=await buildSourceQueryContext(f.result);assert.equal(context.sources.length,1);assert.match(context.sources[0].excerpt,/actual_amount/);
 const tools=sourceQueryTools(context);const page=await tools.run('read_source_evidence',{ref:context.sources[0].ref,startLine:2});assert.equal(page.lines[0].line,2);assert.match(page.lines[0].text,/year_month/);
 await assert.rejects(tools.run('read_source_evidence',{ref:'/etc/passwd'}),/引用/);
 await assert.rejects(tools.run('read_source_evidence',{ref:context.sources[0].ref,startLine:-1}),/行号/);
 await writeFile(path.join(f.root,'Mapper.xml'),'changed');await assert.rejects(tools.run('read_source_evidence',{ref:context.sources[0].ref}),/变化/);
 assert.equal((await buildSourceQueryContext(f.result)).sources.length,0);
});
test('foreign paths, symlinks, secret/config files and unverified artifacts cannot enter source evidence',async t=>{
 const f=await fixture(t);await symlink('/etc/passwd',path.join(f.root,'Link.xml'));await writeFile(path.join(f.root,'credentials.local.json'),'secret');
 for(const artifact of [{...f.result.verifiedArtifacts[0],path:'../escape.xml'},{...f.result.verifiedArtifacts[0],path:'/etc/passwd'},{...f.result.verifiedArtifacts[0],path:'Link.xml'},{...f.result.verifiedArtifacts[0],path:'credentials.local.json'}])assert.equal((await buildSourceQueryContext({...f.result,verifiedArtifacts:[artifact]})).sources.length,0);
 assert.equal((await buildSourceQueryContext({...f.result,handoffGate:{passed:false}})).sources.length,0);
});
test('new verified source preparation can recover a stalled data step once; prose and reused evidence cannot reset it',async t=>{
 const f=await fixture(t),context=await buildSourceQueryContext(f.result),proof=context.preparation;
 const current={...f.result,sourcePreparation:proof,investigation:{goals:[{id:'original-question',required:true,status:'open',evidence:'SQL mapping now available'}]}};
 const job={id:'j',questionId:'q',taskIntent:'analysis',events:[],investigationProgress:{stagnant:2,seen:[],preparationSeen:[],preparationRecoveries:0}};
 const request={environmentId:'db',queryId:'investigate',parameters:['get data'],goalIds:['original-question']};
 const decision=environmentContinuation({jobs:[job]},job,request,current);assert.equal(decision.continue,true);assert.equal(decision.metadata.sourcePreparationRecovery,true);
 job.investigationProgress.preparationSeen=decision.metadata.sourcePreparationKeys;
 assert.equal(environmentContinuation({jobs:[job]},job,{...request,parameters:['reword']},{...current,finalMessage:'new words'}).continue,true);
 job.investigationProgress.preparationSeen=[];job.investigationProgress.preparationRecoveries=2;assert.equal(environmentContinuation({jobs:[job]},job,request,current).continue,true);
 job.investigationProgress.preparationRecoveries=0;job.events=Array.from({length:20},()=>({type:'continuous_environment_started'}));assert.equal(environmentContinuation({jobs:[job]},job,request,current).continue,true);
});
test('source pages redact connection credentials, remain bounded and recheck authorization',async t=>{
 const f=await fixture(t),context=await buildSourceQueryContext(f.result);let allowed=true,calls=0;
 const tools=sourceQueryTools(context,{secrets:['actual_amount'],authorize:async()=>{calls++;if(!allowed)throw new Error('revoked');}});
 const page=await tools.run('read_source_evidence',{ref:context.sources[0].ref});assert.match(JSON.stringify(page),/已隐藏/);assert.doesNotMatch(JSON.stringify(page),/actual_amount/);assert.equal(calls,2);
 allowed=false;await assert.rejects(tools.run('read_source_evidence',{ref:context.sources[0].ref}),/revoked/);
});
test('preparation recovery is durable and identical purpose can run once with new verified evidence',async t=>{
 const {JsonStore}=await import('../src/shared/store.js');
 const f=await fixture(t),context=await buildSourceQueryContext(f.result),store=new JsonStore(path.join(f.root,'state.json'));
 const {job}=await store.createJob({questionId:'q',projectId:'p',chatId:'g',taskIntent:'analysis',continuousInvestigation:true,stage:'developer',instruction:'export'});
 const identity={leaseId:'l',runnerId:'r'},plan={environmentId:'db',queryId:'investigate',parameters:['same purpose']};
 await store.transact(s=>{const j=s.jobs.find(x=>x.id===job.id);j.status='running';j.lease={id:'l',runnerId:'r',expiresAt:new Date(Date.now()+60000).toISOString()};j.investigationProgress={stagnant:2,seen:[],rounds:2};});
 await store.beginContinuousEnvironment(job.id,identity,plan,f.result);
 await store.transact(s=>{const j=s.jobs.find(x=>x.id===job.id);delete j.environmentAccess;j.investigationProgress.stagnant=2;});
 const source={...f.result,sourcePreparation:context.preparation,investigation:{goals:[{id:'original-question',required:true,status:'open',evidence:'new concrete source rules'}]}};
 const before=await store.getJob(job.id),decision=environmentContinuation(await store.read(),before,{...plan,goalIds:['original-question']},source);
 assert.equal(decision.continue,true);
 const updated=await store.beginContinuousEnvironment(job.id,identity,{...plan,...decision.metadata},source);
 assert.equal(updated.investigationProgress.stagnant,0);assert.equal(updated.investigationProgress.preparationRecoveries,1);assert.equal(updated.investigationProgress.preparationSeen.length,1);
 const restarted=new JsonStore(path.join(f.root,'state.json'));const saved=await restarted.getJob(job.id);saved.investigationProgress.stagnant=2;
 assert.equal(environmentContinuation({jobs:[saved]},saved,{...plan,goalIds:['original-question']},source).continue,true);
});
test('same source on another question job and website retries cannot bypass the recovery bound',async t=>{
 const f=await fixture(t),context=await buildSourceQueryContext(f.result),source={...f.result,sourcePreparation:context.preparation,investigation:{goals:[{id:'original-question',required:true,status:'open',evidence:'known source'}]}};
 const job={id:'new',questionId:'q',taskIntent:'analysis',investigationProgress:{stagnant:2}},request={environmentId:'db',queryId:'investigate',goalIds:['original-question']};
 const old={id:'old',questionId:'q',taskIntent:'analysis',investigationProgress:{preparationRecoveries:2}};
 assert.equal(environmentContinuation({jobs:[old,job]},job,request,source).continue,true);
 assert.equal(environmentContinuation({jobs:[job]},job,{...request,kind:'website'},source).continue,true);
});

test('metadata-only rounds do not present zero records as a business query finding',async()=>{
 const {presentEnvironmentResult}=await import('../src/runner/environment-result-presentation.js');
 const r=presentEnvironmentResult({kind:'mysql',tier:'prd',description:'readonly investigation'},{partial:true,rows:[],summary:'已核对连接和结构',evidence:{businessQueryCount:0,readAt:new Date().toISOString()}});
 assert.match(r.summary,/未执行业务数据查询/);assert.doesNotMatch(r.metadata,/返回 0 条去重结果/);
});
test('dataset and source-input failures have fixed actionable stages, not an unclassified execution error',async()=>{
 const {failureDiagnostic}=await import('../src/shared/failure-diagnostic.js');
 const message=failureDiagnostic(Object.assign(new Error('[REPORT_INPUT] invalid datasetRef'),{diagnosticStage:'inspect_dataset'}));
 assert.match(message,/REPORT_INPUT/);assert.match(message,/读取任务内数据集/);assert.doesNotMatch(message,/EXECUTION_ERROR/);
});
