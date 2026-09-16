import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/shared/store.js';
import { jobCard } from '../src/control-plane/message-cards.js';
import { failureDiagnostic, safeExecutionError } from '../src/shared/failure-diagnostic.js';
test('claimed environment partial results survive completion without source-analysis artifacts', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'env-partial-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store = new JsonStore(path.join(dir,'state.json'));
 const plan = { environmentId:'test', queryId:'investigate', scopeHash:'scope', approvedBy:'owner', startedAt:'2026-01-01T00:00:00Z' };
 const { job: j } = await store.createJob({ projectId:'p', taskIntent:'analysis', workflow:'single_developer', stage:'developer', instruction:'read', environmentAccess:plan });
 const job = await store.leaseNext('r');
 await store.transact(s=>s.jobs[0].events.push({type:'environment_query_started',scopeHash:'scope'}));
 const result = {outcome:'partial', summary:'部分结果：缺少其他配置引用', finalMessage:'已有证据；仍有引用未解析', environmentEvidence:{environmentId:'test',queryId:'investigate',scopeHash:'scope',readAt:'2026-01-01T00:01:00Z',rowCount:1,resultHash:'a'.repeat(64)}};
 const event = {type:'completed',runnerId:'r',leaseId:job.lease.id,result};
 for (const patch of [{scopeHash:'other'}, {environmentId:'other'}, {resultHash:'bad'}, {rowCount:-1}, {readAt:'invalid'}]) {
  await assert.rejects(store.appendEvent(j.id,{...event,result:{...result,environmentEvidence:{...result.environmentEvidence,...patch}}}), /Invalid partial environment evidence/);
 }
 await store.transact(s=>{s.jobs[0].environmentAccess.startedAt=null;});
 await assert.rejects(store.appendEvent(j.id,event),/Invalid partial environment evidence/);
 await store.transact(s=>{s.jobs[0].environmentAccess.startedAt=plan.startedAt;});
 const done=await store.appendEvent(j.id,event);
 assert.equal(done.job.status,'completed'); assert.deepEqual(done.job.result,result);
 assert.equal(jobCard(done.job).header.template,'orange');
 await assert.rejects(store.appendEvent(j.id,event), /terminal|Stale or foreign/);
});
test('failure cards show bounded cause and remedy without copying arbitrary error bodies',()=>{
 for(const [message, code] of [['Invalid partial analysis evidence','RESULT_CONTRACT'],['ETIMEDOUT password=synthetic-secret','TIMEOUT'],['fetch failed Authorization: Bearer synthetic-secret','NETWORK'],['unrecognized synthetic-secret','EXECUTION_ERROR']]) {
  const job={id:'test-job',status:'failed',stage:'developer',result:{error:message},events:[]};
  const rendered=JSON.stringify(jobCard(job)); assert.match(rendered,new RegExp(code)); assert.match(rendered,/失败环节/); assert.match(rendered,/建议/); assert.doesNotMatch(rendered,/synthetic-secret/);
  assert.equal(failureDiagnostic(safeExecutionError(new Error(message))),failureDiagnostic(message));
 }
});

test('native MySQL TLS unsupported code becomes an actionable secret-free diagnostic',()=>{
 const error=Object.assign(new Error('Server does not support secure connection password=synthetic-secret'),{code:'HANDSHAKE_NO_SSL_SUPPORT'});
 const diagnostic=failureDiagnostic(error);assert.match(diagnostic,/TLS_UNSUPPORTED/);assert.match(diagnostic,/尚未开始查询/);assert.doesNotMatch(diagnostic,/synthetic-secret/);
 assert.equal(failureDiagnostic(safeExecutionError(error)),diagnostic);
});
