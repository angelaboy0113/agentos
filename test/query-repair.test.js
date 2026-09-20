import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {queryRejection} from '../src/shared/query-repair.js';
import {planQuery} from '../src/shared/environment-access.js';
import {createControlPlane} from '../src/control-plane/server.js';
const env=()=>({version:1,environments:{uat:{kind:'nacos',projectId:'p',tier:'uat',credentialRef:'fake',baseUrl:'https://example.test/nacos',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'Read configuration',namespaces:['uat'],maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string',maxLength:200}]}}}}});
const request=parameters=>({environmentId:'uat',queryId:'investigate',parameters});
const actor={senderId:'member',profile:'owner'};
test('parameter diagnostics explain the actual constraint without retaining values or arbitrary errors',()=>{
 for(const [parameters,code] of [[['SECRET'.repeat(40)],'TEXT_PARAMETER'],[['line\nbreak'],'TEXT_PARAMETER'],[[],'PARAMETER_COUNT']]){
  let error;try{planQuery(env(),request(parameters),'p',actor);}catch(e){error=e;}
  const d=queryRejection(error,{context:[]});assert.equal(d.code,code);assert.equal(d.retry,true);assert.doesNotMatch(JSON.stringify(d),/SECRET|line|break/);
 }
 const unknown=queryRejection(new Error('password=do-not-expose'),{});assert.equal(unknown.retry,false);assert.doesNotMatch(JSON.stringify(unknown),/password|do-not-expose/);
 const denied=queryRejection(new Error('环境或查询模板未配置；请管理员在本机配置'),{});assert.equal(denied.retry,false);
});
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'query-repair-'));const previous=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(env()));
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'state.json'),conversationFile:path.join(dir,'conversation.json'),memoryFile:path.join(dir,'memory.json'),runnerToken:'test',projects:{projects:{p:{repoPath:dir}}},agents:{agents:{developer:{profile:'dev'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;await rm(dir,{recursive:true,force:true});});
 const {job}=await app.store.createJob({questionId:'q',projectId:'p',chatId:'g',taskIntent:'analysis',stage:'developer',workflow:'analysis_review',senderId:'member',originProfile:'owner',instruction:'Check actual budget amounts',attachments:[{id:'image'}],context:[{stage:'developer',result:{investigation:{goals:[{id:'amounts',status:'open',evidence:'Needs amounts'}]}}}]});
 const send=async(j,parameters)=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${j.id}/events`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({type:'completed',runnerId:'r',leaseId:j.lease.id,result:{outcome:'needs_clarification',environmentQuery:request(parameters)}})});
 return {app,send,job};
}
test('HTTP rejected plan resumes original source task once, and corrected read request auto-runs',async t=>{
 const {app,send,job}=await fixture(t);const leased=await app.store.leaseNext('r');assert.equal((await send(leased,['x'.repeat(201)])).status,200);assert.equal((await send(leased,['x'.repeat(201)])).status,409);
 let s=await app.store.read();assert.equal(s.jobs.length,2);const next=s.jobs[1];assert.equal(next.status,'queued');assert.equal(next.originalQuestion,job.originalQuestion);assert.equal(next.senderId,'member');assert.equal(next.attachments[0].id,'image');assert.equal(next.environmentAccess,undefined);assert.equal(next.context.at(-1).result.queryRejection.code,'TEXT_PARAMETER');assert.equal(next.context[0].result.investigation.goals[0].id,'amounts');
 const retry=await app.store.leaseNext('r');assert.equal((await send(retry,['核对预算金额'])).status,200);s=await app.store.read();assert.equal(s.jobs.length,3);assert.equal(s.jobs[2].status,'queued');assert.equal(s.jobs[2].environmentAccess.approvedBy,'policy:read-only');assert.equal(s.jobs[2].senderId,'member');assert.equal((await app.store.leaseNext('r')).id,s.jobs[2].id);
});
test('repeated invalid plans stop without executing or granting a query',async t=>{
 const {app,send}=await fixture(t);
 for(let i=0;i<3;i++){const j=await app.store.leaseNext('r');assert.ok(j);assert.equal((await send(j,['x'.repeat(201+i)])).status,200);}
 const s=await app.store.read();assert.equal(s.jobs.length,3);assert.equal(s.jobs[2].status,'blocked');assert.equal(s.jobs[2].result.queryRejection.attempt,3);assert.match(s.jobs[2].result.summary,/连续自查/);assert.equal(s.jobs.some(j=>j.environmentAccess),false);assert.equal(await app.store.leaseNext('r'),null);
});
