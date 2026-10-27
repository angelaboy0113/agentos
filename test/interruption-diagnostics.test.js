import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {failureDetails,failureDiagnostic,safeExecutionError} from '../src/shared/failure-diagnostic.js';
import {AgentRunner} from '../src/runner/index.js';
import {executeTaskProcess} from '../src/runner/task-process.js';
import {codexExecutionError,publicCodexEvent} from '../src/runner/codex-executor.js';
import {jobCard} from '../src/control-plane/message-cards.js';
import {JsonStore} from '../src/shared/store.js';
const fixture=fileURLToPath(new URL('../test-support/diagnostic-worker.mjs',import.meta.url));
const source={handoffGate:{passed:true},finalMessage:'已核实订单业务规则',investigation:{goals:[{id:'original-question',status:'open',evidence:'剩余金额待核验'}]}};
const job={id:'j',questionId:'q',projectId:'demo',taskIntent:'analysis',stage:'developer',continuousInvestigation:true,lease:{id:'lease',runnerId:'runner'},context:[{kind:'analysis_turn',result:source}]};

test('network causes survive safe wrapping without exposing URLs, credentials or guessing local outage',()=>{
 for(const [raw,expected]of [['ECONNRESET','NETWORK_RESET'],['ENOTFOUND','NETWORK_DNS'],['ECONNREFUSED','NETWORK_REFUSED'],['ETIMEDOUT','TIMEOUT'],['EACCES','LOCAL_PERMISSION']]){
  const error=Object.assign(new Error('fetch failed https://private.invalid/?token=synthetic-secret'),{cause:{code:raw},diagnosticStage:'codex_execution'});
  const safe=safeExecutionError(error),d=failureDetails(safe);assert.equal(d.code,expected);assert.equal(d.observedCode,raw);assert.equal(d.stage,'codex_execution');assert.doesNotMatch(JSON.stringify(d)+safe.message,/synthetic-secret|private.invalid/);
 }
 const unknown=failureDiagnostic(Object.assign(new Error('uncategorized synthetic-secret'),{code:'PASSWORD_SECRET',diagnosticStage:'malicious secret'}));assert.match(unknown,/尚未确认/);assert.doesNotMatch(unknown,/PASSWORD_SECRET|synthetic-secret|malicious/);
});
test('model stream failures, malformed results and process signals remain distinct',()=>{
 const error=codexExecutionError({failure:'Codex turn failed',lastEventError:'stream disconnected before completion token=synthetic-secret',code:1});assert.equal(failureDetails(error).code,'CODEX_STREAM_INTERRUPTED');assert.match(failureDiagnostic(error),/不能区分本机网络、代理或上游服务/);
 const event=publicCodexEvent({type:'error',message:'stream disconnected before completion token=synthetic-secret',url:'https://private.invalid'});assert.doesNotMatch(JSON.stringify(event),/synthetic-secret|private.invalid/);
 assert.equal(failureDetails(codexExecutionError({failure:'Codex turn failed',stderr:'unrelated credential configuration warning',code:1})).code,'CODEX_TURN_FAILED');
 assert.equal(failureDetails(new Error('Codex result invalid: unexpected token')).code,'CODEX_RESULT_INVALID');
 const signal=failureDiagnostic({code:'TASK_WORKER_EXIT',exitSignal:'SIGKILL',exitCode:null});assert.match(signal,/SIGKILL/);assert.match(signal,/不能单独证明/);
});
test('real worker IPC preserves error classification, stage and cause code',async()=>{
 await assert.rejects(executeTaskProcess(job,{},async()=>{},new AbortController().signal,fixture),error=>{
  const d=failureDetails(error);assert.equal(d.code,'NETWORK_RESET');assert.equal(d.stage,'codex_execution');assert.equal(d.observedCode,'ECONNRESET');assert.doesNotMatch(error.message,/synthetic-secret|private.invalid/);return true;
 });
});
test('worker exiting without a result records its actual exit code',async()=>{
 await assert.rejects(executeTaskProcess({...job,fixtureExit:true},{},async()=>{},new AbortController().signal,fixture),error=>{const d=failureDetails(error);assert.equal(d.code,'TASK_WORKER_EXIT');assert.equal(d.exitCode,7);return true;});
});
test('two systems display preserved evidence and precise interruption causes on red cards without replay',async()=>{
 for(const projectId of ['system-a','system-b']){
  let runs=0;const runner=new AgentRunner({},async()=>{runs++;throw Object.assign(new Error('fetch failed token=synthetic-secret'),{cause:{code:'ECONNRESET'},diagnosticStage:'codex_execution'});});
  const result=await runner.executeContinuous({...job,projectId},async()=>{},new AbortController().signal);assert.equal(runs,1);assert.equal(result.outcome,'blocked');assert.equal(result.executionFailure.code,'NETWORK_RESET');assert.match(result.finalMessage,/已核实订单业务规则|剩余金额待核验/);assert.match(result.finalMessage,/ECONNRESET/);
  const card=JSON.stringify(jobCard({...job,projectId,status:'blocked',result,events:[]}));assert.match(card,/模型分析与结果返回/);assert.match(card,/连接在通信过程中/);assert.doesNotMatch(card,/synthetic-secret|执行器未完成后续步骤/);
 }
});
test('structured failure survives terminal persistence and reopen',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'interruption-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json'),store=new JsonStore(file);const {job:created}=await store.createJob({projectId:'demo',taskIntent:'analysis',stage:'developer',instruction:'synthetic'});const leased=await store.leaseNext('runner');const runner=new AgentRunner({},async()=>{throw Object.assign(new Error('timeout'),{code:'CODEX_RPC_TIMEOUT',diagnosticStage:'account/read'});});const result=await runner.executeContinuous({...job,id:created.id},async()=>{},new AbortController().signal);await store.appendEvent(created.id,{type:'completed',runnerId:'runner',leaseId:leased.lease.id,result});const saved=await new JsonStore(file).getJob(created.id);assert.equal(saved.status,'blocked');assert.equal(saved.result.executionFailure.stage,'account/read');assert.match(JSON.stringify(jobCard(saved)),/核对本机Codex登录状态/);
});
test('HTTP status and result submission stage stay visible without replaying state changes',async()=>{
 let posts=0;const runner=new AgentRunner({},async()=>({outcome:'ready',finalMessage:'已取得证据'}));runner.post=async()=>{posts++;throw Object.assign(new Error('synthetic-secret'),{statusCode:503,diagnosticStage:'control_result'});};const result=await runner.executeContinuous({...job,environmentAccess:{}},async()=>{},new AbortController().signal);assert.equal(posts,1);assert.match(result.finalMessage,/保存任务结果与状态回执/);assert.match(result.finalMessage,/HTTP状态：503/);assert.doesNotMatch(result.finalMessage,/synthetic-secret/);
});
