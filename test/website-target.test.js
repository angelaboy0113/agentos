import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {websiteKey,websiteSessionKey} from '../src/shared/website-policy.js';
import {prepareWebsiteQuery} from '../src/control-plane/website-query.js';
import {loadEnvironments,catalog,planQuery} from '../src/shared/environment-access.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
test('same-origin applications use distinct entries while retaining original login profile key',()=>{
 const scheduler='https://site.example/xxl-job-admin',business='https://site.example/tpm';
 assert.notEqual(websiteKey('demo','uat',scheduler),websiteKey('demo','uat',business));
 assert.equal(websiteSessionKey('demo','uat',scheduler),websiteSessionKey('demo','uat',business));
 assert.notEqual(websiteSessionKey('demo','uat',business),websiteSessionKey('demo','prd',business));
});
test('legacy origin registration cannot replace requested application path and catalog exposes exact entry',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'target-test-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});
 const context={projects:{ownerOpenIdsByProfile:{owner:['ou_admin']}}},job={projectId:'demo',sourceEnvironment:'uat',originProfile:'owner'};
 const scheduler='https://site.example/xxl-job-admin',business='https://site.example/tpm';
 const first=await prepareWebsiteQuery(context,job,{url:scheduler,tier:'uat',purpose:'查调度'});
 const cfg=await loadEnvironments();cfg.environments[websiteSessionKey('demo','uat',scheduler)]=cfg.environments[first.environmentId];delete cfg.environments[first.environmentId];await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const next=await prepareWebsiteQuery(context,job,{url:business,tier:'uat',purpose:'查活动审批'}),updated=await loadEnvironments();
 assert.equal(updated.environments[next.environmentId].baseUrl,business);
 assert.equal(updated.environments[websiteSessionKey('demo','uat',scheduler)].baseUrl,scheduler);
 assert.equal(catalog(updated,'demo').find(e=>e.environmentId===next.environmentId).queries[0].scope.entryUrl,business);
 assert.equal((await prepareWebsiteQuery(context,job,{url:business,tier:'uat',purpose:'查业务'})).environmentId,next.environmentId);
});
test('wrong-page report produces partial source handoff evidence rather than a scope failure',async()=>{
 const e={projectId:'demo',kind:'website',tier:'uat',baseUrl:'https://site.example/xxl-job-admin',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'业务核验',parameters:[{name:'purpose',type:'string'}],maxRows:20,timeoutMs:1000}}};
 const cfg={version:1,environments:{web:e}},plan=planQuery(cfg,{environmentId:'web',queryId:'investigate',parameters:['查看活动审批']},'demo',{profile:'owner',senderId:'ou_member'});let calls=0;
 const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,tools:async()=>({spec:[{tool:'connection'},{tool:'report_wrong_site'}],run:async tool=>{calls++;return tool==='connection'?{pageText:'XXL-JOB任务调度中心'}:{websiteMismatch:true,partial:true};},close:async()=>{}}),planner:async()=>({next:async()=>({tool:'report_wrong_site',arguments:'{}'}),close:async()=>{}})});
 assert.equal(calls,2);assert.equal(result.websiteMismatch,true);assert.equal(result.partial,true);assert.match(result.summary,/入口不匹配/);assert.doesNotMatch(result.summary,/SCOPE_LIMIT/);assert.ok(result.evidence.resultHash);
});
