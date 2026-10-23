import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {sourceRuntimeTier,sourceEnvironmentForTier,assertSourceRuntimeTier,sourceEnvironmentCatalog,selectSourceEnvironment} from '../src/shared/source-environments.js';
import {prepareWebsiteQuery} from '../src/control-plane/website-query.js';
import {queryRejection} from '../src/shared/query-repair.js';
import {interruptedInvestigation} from '../src/shared/investigation-budget.js';
import {createControlPlane} from '../src/control-plane/server.js';
const project={analysisSourceMode:'isolated',analysisEnvironments:{sit:{},prd:{}}};
test('source IDs and runtime tiers map in both directions, with custom project-local IDs',()=>{
 for(const id of ['sit','uat','test','testing'])assert.equal(sourceRuntimeTier(null,id),'uat');
 for(const id of ['prd','prod','production'])assert.equal(sourceRuntimeTier(null,id),'prd');
 assert.equal(sourceEnvironmentForTier(project,'uat'),'sit');assert.equal(sourceEnvironmentForTier(project,'prd'),'prd');
 const custom={analysisSourceMode:'isolated',analysisEnvironments:{blue:{runtimeTier:'uat'},live:{runtimeTier:'prd'}}};
 assert.equal(sourceEnvironmentForTier(custom,'uat'),'blue');assert.equal(sourceEnvironmentForTier(custom,'prd'),'live');
 assert.equal(sourceEnvironmentCatalog(custom)[0].runtimeTier,'uat');assert.equal(selectSourceEnvironment(custom,'blue'),'blue');
});
test('unknown, ambiguous and production-to-test mappings fail closed without breaking source-only catalogs',()=>{
 const custom={analysisSourceMode:'isolated',analysisEnvironments:{blue:{}}};
 assert.throws(()=>assertSourceRuntimeTier(project,'sit','prd'),e=>e.queryDiagnostic.code==='ENVIRONMENT_MISMATCH');
 assert.throws(()=>sourceEnvironmentForTier({...project,analysisEnvironments:{sit:{},uat:{},prd:{}}},'uat'),e=>e.queryDiagnostic.code==='SOURCE_ENVIRONMENT_SELECTION');
 assert.throws(()=>sourceRuntimeTier(custom,'blue'),e=>e.queryDiagnostic.code==='SOURCE_TIER_UNMAPPED');
 assert.equal(sourceEnvironmentCatalog(custom)[0].mappingIssue,'SOURCE_TIER_UNMAPPED');assert.equal(selectSourceEnvironment(custom,'blue'),'blue');
 assert.throws(()=>sourceRuntimeTier({analysisEnvironments:{prd:{runtimeTier:'uat'}}},'prd'),e=>e.queryDiagnostic.code==='SOURCE_TIER_CONFIG');
 assert.throws(()=>sourceRuntimeTier(project,'other'),e=>e.queryDiagnostic.code==='SOURCE_ENVIRONMENT_UNKNOWN');
 assert.equal(sourceEnvironmentForTier({...project,defaultSourceEnvironment:'prd'},'uat'),'sit');
});
test('website registration works for SIT and custom test IDs, preserving project and URL scopes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'env-map-')),prev=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(prev===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=prev;await rm(dir,{recursive:true,force:true});});
 const context={projects:{projects:{a:project,b:{analysisSourceMode:'isolated',analysisEnvironments:{blue:{runtimeTier:'uat'}}}},ownerOpenIdsByProfile:{owner:['ou_admin']}}};
 const request={tier:'uat',url:'https://test.example/orders',purpose:'检查列表与只读详情'};
 const a=await prepareWebsiteQuery(context,{projectId:'a',sourceEnvironment:'sit',originProfile:'owner'},request);
 const b=await prepareWebsiteQuery(context,{projectId:'b',sourceEnvironment:'blue',originProfile:'owner'},request);
 assert.notEqual(a.environmentId,b.environmentId);
 const cfg=JSON.parse(await readFile(process.env.AGENTOS_ENVIRONMENTS_FILE));assert.equal(cfg.environments[a.environmentId].tier,'uat');assert.equal(cfg.environments[a.environmentId].baseUrl,'https://test.example/orders');
 const original=await readFile(process.env.AGENTOS_ENVIRONMENTS_FILE,'utf8');
 await assert.rejects(()=>prepareWebsiteQuery(context,{projectId:'a',sourceEnvironment:'sit'}, {...request,tier:'prd'}),e=>{const d=queryRejection(e,{});assert.equal(d.code,'ENVIRONMENT_MISMATCH');assert.equal(d.retry,false);return true;});
 assert.equal(await readFile(process.env.AGENTOS_ENVIRONMENTS_FILE,'utf8'),original);
});
test('website malformed parameters have actionable bounded diagnostics, not an unclassified plan failure',async()=>{
 for(const purpose of ['', 'x'.repeat(201), 'line\nbreak'])await assert.rejects(()=>prepareWebsiteQuery({projects:{}},{sourceEnvironment:'sit'},{tier:'uat',purpose}),e=>{const d=queryRejection(e,{});assert.equal(d.code,'TEXT_PARAMETER');assert.equal(d.retry,true);assert.doesNotMatch(JSON.stringify(d),/line|break|xxxx/);return true;});
});
test('continuous HTTP planning accepts mapped SIT web access but rejects PRD DB access for SIT',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'env-map-http-')),prev=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 const app=await createControlPlane({dataDir:dir,runnerToken:'test',projects:{chatProjectMap:{g:'a'},projects:{a:{...project,repoPath:dir}},ownerOpenIdsByProfile:{owner:['ou_admin']}},agents:{agents:{developer:{profile:'dev'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));if(prev===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=prev;await rm(dir,{recursive:true,force:true});});
 const {job}=await app.store.createJob({projectId:'a',questionId:'q',taskIntent:'analysis',workflow:'continuous_analysis',continuousInvestigation:true,stage:'developer',sourceEnvironment:'sit',senderId:'ou_member',originProfile:'owner',chatId:'g'});
 const leased=await app.store.leaseNext('runner');
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/continuous-environment`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({runnerId:'runner',leaseId:leased.lease.id,result:{outcome:'needs_clarification',websiteQuery:{tier:'uat',url:'https://test.example/orders',purpose:'检查网页'}}})});
 const result=await response.json();assert.equal(response.status,200);assert.equal(result.planned,true,JSON.stringify(result.diagnostic));assert.equal(result.plan.tier,'uat');assert.equal((await app.store.getJob(job.id)).sourceEnvironment,'sit');
 const cfg=JSON.parse(await readFile(process.env.AGENTOS_ENVIRONMENTS_FILE));cfg.environments.production={kind:'mysql',projectId:'a',tier:'prd',host:'database.example',port:3306,database:'business',credentialRef:'fixture',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{clock:{reviewed:true,description:'读取时间',sql:'SELECT 1 AS value',outputColumns:['value'],parameters:[],maxRows:1,timeoutMs:1000}}};
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const other=(await app.store.createJob({projectId:'a',questionId:'q2',taskIntent:'analysis',workflow:'continuous_analysis',continuousInvestigation:true,stage:'developer',sourceEnvironment:'sit',senderId:'ou_member',originProfile:'owner',chatId:'g'})).job;
 const l2=await app.store.leaseNext('runner2');assert.equal(l2.id,other.id);
 const denied=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${other.id}/continuous-environment`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({runnerId:'runner2',leaseId:l2.lease.id,result:{outcome:'needs_clarification',environmentQuery:{environmentId:'production',queryId:'clock',parameters:[]}}})});
 const rejected=await denied.json();assert.equal(rejected.planned,false);assert.equal(rejected.diagnostic.code,'ENVIRONMENT_MISMATCH');assert.equal((await app.store.getJob(other.id)).environmentAccess,undefined);assert.doesNotMatch(rejected.terminalResult?.finalMessage??'',/同一无效查询在自查后仍未修正/);
 cfg.environments.testing={...cfg.environments.production,tier:'uat'};await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const turn={id:'runtime-first',questionId:'q3',chatId:'g',chatType:'group',profile:'owner',role:'owner_intake',senderId:'ou_member',messageId:'request',decision:{action:'create_task',intent:'analysis',instruction:'检查测试环境数据',environmentQuery:{environmentId:'testing',queryId:'clock',parameters:[]},attachmentIds:[]}};
 const created=await app.conversations.apply(turn);assert.ok(created.jobId,JSON.stringify(created));assert.equal((await app.store.getJob(created.jobId)).sourceEnvironment,'sit');


});
test('first permanent rejection does not claim repeated failures or present source plans as ongoing work',()=>{
 const r=interruptedInvestigation({context:[{result:{handoffGate:{passed:true},finalMessage:'下一阶段将打开网页',summary:'已找到入口'}}]},'环境分级不一致','ENVIRONMENT_MISMATCH');
 assert.equal(r.outcome,'blocked');assert.match(r.finalMessage,/源码阶段历史记录（其中的后续计划已停止，不会自动执行）/);assert.match(r.finalMessage,/下一阶段将打开网页/);
});
