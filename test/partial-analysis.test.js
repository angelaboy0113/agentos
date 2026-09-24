import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonStore } from '../src/shared/store.js';
import { validateHandoff, enforceHandoff, preserveAnalysisGaps, preserveEnvironmentEvidence } from '../src/runner/harness.js';
import { assessInvestigation } from '../src/shared/investigation-review.js';
import { jobCard } from '../src/control-plane/message-cards.js';
import { jobTerminalMention } from '../src/control-plane/requester-mention.js';
const handoff = () => ({ artifacts: [{ kind: 'code', path: 'code.js' }], checks: [
  { id: 'core', required: true, status: 'passed', evidence: 'code.js inspected' },
  { id: 'extra_branch', required: false, status: 'not_run', evidence: 'outside synchronized scope' },
], risks: ['Extra branch and deployment not verified'], returnTo: 'none' });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'code.js'), 'export const known = true;');
  return root;
}
test('partial analysis requires verified source and gaps without weakening mandatory checks', async (t) => {
  const root = await fixture(t), job = { taskIntent: 'analysis', stage: 'developer' };
  const result = { outcome: 'partial', finalMessage: 'Known finding; extra branch not verified', handoff: handoff() };
  const gate = await validateHandoff(job, result, root);
  assert.deepEqual(gate.issues, []);
  assert.equal(enforceHandoff(result, gate).outcome, 'partial');
  for (const change of [h => { h.checks[0].status = 'failed'; }, h => { h.artifacts = []; }, h => { h.risks = []; }]) {
    const h = handoff(); change(h);
    assert.equal(enforceHandoff({ ...result, handoff: h }, await validateHandoff(job, { ...result, handoff: h }, root)).outcome, 'blocked');
  }
  assert.ok((await validateHandoff({ ...job, taskIntent: 'implementation' }, result, root)).issues.length);
});
test('partial analysis may preserve a required check as not run when other required evidence passed', async (t) => {
  const root = await fixture(t), job = { taskIntent: 'analysis', stage: 'developer' };
  const h = handoff(); h.checks[1].required = true;
  const result = { outcome: 'partial', summary: '核心原因已核实，审计时间待补齐',
    finalMessage: '已确认金额关系；释放流水精确时间受工具字段限制。', handoff: h };
  const gate = await validateHandoff(job, result, root);
  assert.deepEqual(gate.issues, []);
  const enforced = enforceHandoff(result, gate);
  assert.equal(enforced.outcome, 'partial');
  assert.equal(enforced.handoffGate.passed, true);
  assert.equal(enforced.handoff.checks[1].status, 'not_run');
  assert.match(enforced.finalMessage, /释放流水/);
  assert.equal(jobCard({ status: 'completed', taskIntent: 'analysis', result: enforced, events: [], createdAt: new Date().toISOString(), id: 'JOB-partial' }).header.template, 'orange');
});
test('unavailable request logs preserve useful question findings as an orange partial result',async t=>{
 const root=await fixture(t),job={taskIntent:'analysis',stage:'developer',originalQuestion:'为什么提交504',questionScopePolicy:'original-question-v1'};
 const assessed=assessInvestigation(job,{outcome:'blocked',summary:'已确认提交后状态',finalMessage:'V3已创建并进入审批，具体慢点待日志。',
  investigation:{status:'wait',goals:[
   {id:'original-question',required:true,status:'open',evidence:'504后V3创建并进入审批，具体慢点未定位'},
   {id:'state',required:false,status:'verified',evidence:'数据库确认V3'},
  ],attempts:['查询数据库'],nextStep:'获取请求日志',causalAssessment:{status:'unknown',link:'unproven',mechanism:'响应超时',evidence:[
   {kind:'database',reference:'V3',finding:'已创建'},
  ],alternatives:'待日志排除'},blocker:{kind:'unavailable',needed:'请求日志',evidence:'未登记日志入口'}},
  handoff:{artifacts:[{kind:'code',path:'code.js'}],checks:[
   {id:'original-question',required:true,status:'failed',evidence:'具体慢点未定位'},
   {id:'state',required:false,status:'passed',evidence:'V3已核实'},
  ],risks:['不要重复提交'],returnTo:'none'}});
 const enforced=enforceHandoff(assessed,await validateHandoff(job,assessed,root));
 assert.equal(enforced.outcome,'partial');assert.equal(enforced.handoffGate.passed,true);
 assert.equal(jobCard({status:'completed',taskIntent:'analysis',result:enforced,events:[],createdAt:new Date().toISOString(),id:'JOB-causal-partial'}).header.template,'orange');
 assert.match(enforced.finalMessage,/V3已创建/);
});
test('question-scoped ready answer requires a passed original-question handoff check',async t=>{
 const root=await fixture(t),job={taskIntent:'analysis',stage:'developer'};
 const result={outcome:'ready',finalMessage:'Confirmed from source and records',investigation:{status:'complete',blocker:null,goals:[
  {id:'original-question',required:true,status:'verified',evidence:'Source and records agree'},
 ]},handoff:handoff()};
 assert.match((await validateHandoff(job,result,root)).issues.join(' '),/原问题验收项/);
 result.handoff.checks[0].id='original-question';
 assert.deepEqual((await validateHandoff(job,result,root)).issues,[]);
});
test('partial developer findings continue to owner exactly once, retain gaps and mention only final report', async (t) => {
  const root = await fixture(t), store = new JsonStore(path.join(root, 'state.json'));
  const result = { outcome: 'partial', summary: 'Known finding; remaining gap', finalMessage: 'Evidence and gaps', handoff: handoff(),
    handoffGate: { passed: true }, verifiedArtifacts: [{ path: 'code.js' }], sourceSync: { repositories: [{ path: '.', commit: 'abc' }] } };
  await store.createJob({ projectId: 'demo', chatId: 'group', taskIntent: 'analysis', workflow: 'analysis_review', stage: 'developer',
    originChatType: 'group', originProfile: 'owner', replyToMessageId: 'origin', senderId: 'ou_member', instruction: 'inspect' });
  const job = await store.leaseNext('runner');
  const event = { type: 'completed', runnerId: 'runner', leaseId: job.lease.id, result };
  const first = await store.appendEvent(job.id, event, { agentRole: 'owner_report', agentProfile: 'owner' });
  assert.equal(first.job.status, 'completed'); assert.equal(first.nextJob.stage, 'owner_report');
  assert.equal(jobTerminalMention(first.job), null);
  assert.deepEqual(first.nextJob.context[0].result.handoff.risks, result.handoff.risks);
  await assert.rejects(store.appendEvent(job.id, event));
  const owner = await store.leaseNext('runner');
  const final = await store.appendEvent(owner.id, { ...event, leaseId: owner.lease.id });
  assert.equal(final.job.status, 'completed'); assert.equal(final.nextJob, null);
  assert.ok(jobTerminalMention(final.job));
  const card = jobCard(final.job);
  assert.equal(card.header.template, 'orange');
  assert.match(JSON.stringify(card), /部分分析完成/);
});
test('unverified, synchronization-blocked and implementation partial results never auto-advance', async (t) => {
  const root = await fixture(t);
  for (const [i, fields] of [{}, { sourceSyncBlocked: true, handoffGate: { passed: true } }, { handoffGate: { passed: true } }].entries()) {
    const store = new JsonStore(path.join(root, `state-${i}.json`));
    await store.createJob({ projectId: 'p', taskIntent: i === 2 ? 'implementation' : 'analysis', workflow: 'analysis_review', stage: 'developer', instruction: 'inspect' });
    const job = await store.leaseNext('r');
    await assert.rejects(store.appendEvent(job.id, { type: 'completed', runnerId: 'r', leaseId: job.lease.id,
      result: { outcome: 'partial', ...fields } }, { agentRole: 'owner_report', agentProfile: 'owner' }), /Invalid partial/);
    assert.equal((await store.read()).jobs.length, 1);
  }
});
test('owner cannot silently upgrade partial findings or discard inherited gaps', () => {
  const prior = { outcome: 'partial', handoff: handoff() };
  const job = { taskIntent: 'analysis', stage: 'owner_report', context: [{ result: prior }] };
  const raw = { outcome: 'ready', summary: 'Finding', finalMessage: 'Details', handoff: { ...handoff(), risks: [], artifacts: [] } };
  const actual = preserveAnalysisGaps(job, raw);
  assert.equal(actual.outcome, 'partial');
  assert.deepEqual(actual.handoff.risks, prior.handoff.risks);
  assert.deepEqual(actual.handoff.artifacts, prior.handoff.artifacts);
  assert.equal(raw.outcome, 'ready');
  assert.equal(preserveAnalysisGaps(job, { outcome: 'blocked' }).outcome, 'blocked');
  assert.equal(preserveAnalysisGaps({ ...job, taskIntent: 'implementation' }, raw), raw);
});
test('final synthesis retains the supporting records returned by a read-only query',()=>{
 const job={taskIntent:'analysis',stage:'developer',context:[{result:{evidenceRecords:[
  {code:'DZ-20260910-0001',status:'approved'},
  {code:'DZ-20260911-0001',status:'approved'},
  {code:'DZ-20260915-0001',status:'approved'},
 ]}}]};
 const output=preserveEnvironmentEvidence(job,{outcome:'ready',summary:'blob URL caused the broken image',finalMessage:'Confirmed root cause'});
 for(const id of ['DZ-20260910-0001','DZ-20260911-0001','DZ-20260915-0001']){
  assert.match(output.summary,new RegExp(id));assert.match(output.finalMessage,new RegExp(id));
 }
 assert.match(output.finalMessage,/关键查询记录/);
});
