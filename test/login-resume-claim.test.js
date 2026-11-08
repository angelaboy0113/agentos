import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {planQuery} from '../src/shared/environment-access.js';
import {pollWebsiteLogins} from '../src/control-plane/website-query.js';
import {failureDiagnostic} from '../src/shared/failure-diagnostic.js';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'login-claim-')),previous=process.env.AGENTOS_ENVIRONMENTS_FILE;
 process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;await rm(dir,{recursive:true,force:true});});
 const cfg={version:1,environments:{web:{projectId:'demo',kind:'website',tier:'prd',credentialRef:'test',baseUrl:'https://jobs.example/admin',membersRead:false,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{reviewed:true,mode:'investigate',description:'查看任务',browser:true,maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]}}}}};
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const plan=planQuery(cfg,{environmentId:'web',queryId:'investigate',parameters:['查看任务记录']},'demo',{senderId:'ou_member',profile:'owner'});
 const file=path.join(dir,'state.json'),store=new JsonStore(file);
 await store.createJob({id:'ignored',projectId:'demo',senderId:'ou_member',originProfile:'owner',questionId:'question',stage:'developer',taskIntent:'analysis',workflow:'single_developer',instruction:'查看任务'});
 const j=(await store.read()).jobs[0];
 await store.transact(s=>{Object.assign(s.jobs[0],{status:'queued',environmentAccess:{...plan,approvedBy:'ou_admin',approvedAt:new Date().toISOString()}});});
 const first=await store.leaseNext('runner');await store.claimEnvironment(j.id,{leaseId:first.lease.id,runnerId:'runner'});
 const wait=async()=>store.transact(s=>{const j=s.jobs[0];j.status='awaiting_clarification';j.lease=null;j.result={browserLoginRequired:true,browserCheckpoint:{steps:['prior evidence'],results:[]}};});
 await wait();return{store,file,id:j.id,first,cfg,wait};
}
test('real store login continuation survives restart, accepts one new lease, rejects stale and repeated claims',async t=>{
 const f=await fixture(t),before=await f.store.getJob(f.id);
 await pollWebsiteLogins({store:f.store,websiteBrowser:{loginReady:async()=>true}});
 const restarted=new JsonStore(f.file),resumed=await restarted.leaseNext('runner');
 await assert.rejects(restarted.claimEnvironment(f.id,{leaseId:f.first.lease.id,runnerId:'runner'}),/租约/);
 const identity={leaseId:resumed.lease.id,runnerId:'runner'};
 const outcomes=await Promise.allSettled([restarted.claimEnvironment(f.id,identity),restarted.claimEnvironment(f.id,identity)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/QUERY_ALREADY_STARTED/);
 const after=await restarted.getJob(f.id);
 assert.equal(after.environmentAccess.startedAt,before.environmentAccess.startedAt);assert.equal(after.environmentAccess.scopeHash,before.environmentAccess.scopeHash);
 assert.equal(after.senderId,'ou_member');assert.equal(after.questionId,'question');assert.equal(after.browserResumeClaim,undefined);assert.deepEqual(after.browserCheckpoint.steps,['prior evidence']);
 assert.equal(after.events.filter(x=>x.type==='environment_query_resumed').length,1);
 // A later login expiry can issue another distinct continuation, not unlimited retries.
 await f.wait();await pollWebsiteLogins({store:restarted,websiteBrowser:{loginReady:async()=>true}});
 const again=await restarted.leaseNext('runner');await restarted.claimEnvironment(f.id,{leaseId:again.lease.id,runnerId:'runner'});
});
test('expired read scope at login refreshes policy authorization; cancellation never resumes',async t=>{
 const f=await fixture(t);
 const started=Date.now()-16*60_000;
 const expired=planQuery(f.cfg,{environmentId:'web',queryId:'investigate',parameters:['查看任务记录']},'demo',{profile:'owner'},started);
 await f.store.transact(s=>{s.jobs[0].environmentAccess={...expired,startedAt:new Date(started).toISOString()};});
 const context={store:f.store,websiteBrowser:{loginReady:async()=>true}};await pollWebsiteLogins(context);
 const j=await f.store.getJob(f.id);assert.equal(j.status,'queued');assert.equal(j.environmentAccess.approvedBy,'policy:read-only');assert.equal(j.browserResumeClaim,undefined);assert.equal((await f.store.leaseNext('runner')).id,f.id);
 await f.store.transact(s=>{s.jobs[0].status='cancelled';});await pollWebsiteLogins(context);assert.equal((await f.store.getJob(f.id)).status,'cancelled');
});
test('scope changes after login detection invalidate continuation before claim',async t=>{
 const f=await fixture(t);await pollWebsiteLogins({store:f.store,websiteBrowser:{loginReady:async()=>true}});
 const leased=await f.store.leaseNext('runner');f.cfg.environments.web.baseUrl='https://different.example/';await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(f.cfg));
 await assert.rejects(f.store.claimEnvironment(f.id,{leaseId:leased.lease.id,runnerId:'runner'}));
 assert.equal((await f.store.getJob(f.id)).events.filter(x=>x.type==='environment_query_resumed').length,0);
});
test('duplicate claim diagnostic identifies continuation problem rather than asking to expand scope',()=>{
 const text=failureDiagnostic(new Error('[QUERY_ALREADY_STARTED] internal detail'));
 assert.match(text,/任务接续校验/);assert.doesNotMatch(text,/SCOPE_LIMIT|扩大范围|internal detail/);
});

test('expired active website scope is renewed only for the same live lease and exact policy scope',async t=>{
 const f=await fixture(t),oldTime=Date.now()-16*60_000;
 const old=planQuery(f.cfg,{environmentId:'web',queryId:'investigate',parameters:['查看任务记录']},'demo',{profile:'owner'},oldTime);
 const identity={leaseId:f.first.lease.id,runnerId:'runner',renewScopeHash:old.scopeHash};
 await f.store.transact(s=>{const job=s.jobs[0];job.status='running';job.lease=f.first.lease;
  job.environmentAccess={...old,startedAt:new Date(oldTime).toISOString()};});
 await assert.rejects(f.store.claimEnvironment(f.id,{...identity,leaseId:'wrong'}),/租约/);
 await assert.rejects(f.store.claimEnvironment(f.id,{...identity,renewScopeHash:'wrong'}),/范围不一致/);
 f.cfg.environments.web.baseUrl='https://different.example/admin';
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(f.cfg));
 await assert.rejects(f.store.claimEnvironment(f.id,identity),/配置已变更/);
 f.cfg.environments.web.baseUrl='https://jobs.example/admin';
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(f.cfg));
 const renewed=await f.store.claimEnvironment(f.id,identity);
 assert.notEqual(renewed.scopeHash,old.scopeHash);
 assert.ok(Date.parse(renewed.expiresAt)>Date.now());
 for(const key of ['environmentId','queryId','parameters','configHash','projectId','approvalProfile','startedAt']){
  assert.deepEqual(renewed[key],key==='startedAt'?new Date(oldTime).toISOString():old[key]);
 }
 await assert.rejects(f.store.claimEnvironment(f.id,identity),/范围不一致/);
 const job=await f.store.getJob(f.id);
 assert.equal(job.events.filter(e=>e.previousScopeHash===old.scopeHash).length,1);
});
test('detected login loss tries saved credentials and resumes only when the page confirms login',async t=>{
 const f=await fixture(t);
 let ready=false, attempts=0;
 const context={store:f.store,websiteBrowser:{loginReady:async()=>ready},
  websiteCredentials:{autoLogin:async()=>{attempts++;return ready;}}};
 await pollWebsiteLogins(context);
 assert.equal((await f.store.getJob(f.id)).status,'awaiting_clarification');
 assert.equal(attempts,1);
 context.websiteCredentials.autoLogin=async()=>{attempts++;ready=true;return true;};
 await pollWebsiteLogins(context);
 assert.equal((await f.store.getJob(f.id)).status,'queued');
 assert.equal(attempts,2);
});
