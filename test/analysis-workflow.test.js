import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkspace } from '../src/runner/workspace.js';
import { analysisThreadId, analysisTimeoutResult, buildCodexArgs, buildPrompt, verificationCommands } from '../src/runner/codex-executor.js';
import { JsonStore } from '../src/shared/store.js';
import { createControlPlane } from '../src/control-plane/server.js';
import { jobCard } from '../src/control-plane/message-cards.js';

const exec = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-analysis-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const input = { projectId: 'demo', chatId: 'group', stage: 'developer', agentProfile: 'dev',
  taskIntent: 'analysis', workflow: 'analysis_review', instruction: '只读调查登录接口', originProfile: 'owner' };
const routing = { agentRole: 'owner_report', agentProfile: 'owner' };

test('analysis reads real nested repository and dirty code without creating a worktree or changing files', async (t) => {
  const directory = await fixture(t), repo = path.join(directory, 'repo'), trees = path.join(directory, 'trees');
  await mkdir(repo);
  await exec('git', ['-C', repo, 'init'], { windowsHide: true });
  const child = path.join(repo, 'sys');
  await mkdir(child);
  await exec('git', ['-C', child, 'init'], { windowsHide: true });
  await writeFile(path.join(child, 'login.js'), 'uncommitted login implementation');
  const before = await exec('git', ['-C', repo, 'status', '--porcelain'], { windowsHide: true });
  const workspace = await prepareWorkspace({ ...input, context: [{ result: { workspace: 'C:/untrusted' } }] }, { repoPath: repo }, trees);
  assert.equal(workspace, await realpath(repo));
  assert.equal(await readFile(path.join(workspace, 'sys/login.js'), 'utf8'), 'uncommitted login implementation');
  assert.equal((await exec('git', ['-C', repo, 'status', '--porcelain'], { windowsHide: true })).stdout, before.stdout);
  await assert.rejects(readdir(trees), { code: 'ENOENT' });
  await assert.rejects(prepareWorkspace(input, { repoPath: path.join(repo, 'missing') }, trees));
});

test('analysis enforces read-only CLI, skips side-effecting verification and uses analysis-specific role instructions', async () => {
  const args = buildCodexArgs('D:/demo', [], { readOnly: true });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('approval_policy="never"'));
  assert.equal(args.includes('--approve-for-me'), false);
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--skip-git-repo-check'), true);
  assert.equal(buildCodexArgs('D:/demo').includes('--skip-git-repo-check'), false);
  assert.deepEqual(verificationCommands(input, { verifyCommands: ['must-not-run'] }, 'ready'), []);
  assert.deepEqual(verificationCommands({ stage: 'developer', taskIntent: 'implementation' }, { verifyCommands: ['test'] }, 'ready'), ['test']);
  assert.match(await buildPrompt(input, {}), /只读调查职责/);
  const report = await buildPrompt({ ...input, stage: 'owner_report', context: [{ stage: 'developer', result: { finalMessage: 'POST /login: sys/login.js:1' } }] }, {});
  assert.match(report, /POST \/login: sys\/login.js:1/);
  assert.match(report, /不要求补齐不适用/);
});

test('same developer investigation resumes its Codex thread instead of starting another agent', () => {
  const job = { taskIntent:'analysis', stage:'developer', context:[
    { stage:'developer', result:{ threadId:'thread-old', workspace:'/snapshot/old' } },
    { stage:'developer', result:{ threadId:'thread-current', workspace:'/snapshot/current' } },
  ] };
  assert.equal(analysisThreadId(job, '/snapshot/current'), 'thread-current');
  const args = buildCodexArgs('/snapshot/current', [], { readOnly:true, resumeThreadId:'thread-current' });
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.equal(args.at(-2), 'thread-current');
  assert.equal(args.at(-1), '-');
  assert.equal(args.includes('-C'), false);
  assert.equal(args.includes('/tmp/repeated.png'),false);
});

test('resumed analysis sends only new evidence and does not repeat the full harness or attachment',async()=>{
 const job={...input,originalQuestion:'很长的原始问题和请求体',context:[
  {stage:'developer',kind:'analysis_turn',result:{threadId:'thread-current',workspace:'/snapshot/current',finalMessage:'旧分析全文'}},
  {stage:'developer',kind:'environment_result',result:{outcome:'partial',summary:'新数据库证据',evidenceRecords:[{total:'504',distinct:'252'}],environmentEvidence:{resultHash:'a'.repeat(64)}}},
 ]};
 const prompt=await buildPrompt(job,{}, {instruction:'完整角色规则不应重复',metadata:{version:'test'}},{workspace:'/snapshot/current'},[], '/snapshot/current');
 assert.match(prompt,/新数据库证据/);assert.match(prompt,/504/);assert.doesNotMatch(prompt,/完整角色规则不应重复|很长的原始问题和请求体|旧分析全文/);
 const args=buildCodexArgs('/snapshot/current',[{type:'image',path:'/tmp/repeated.png'}],{readOnly:true,resumeThreadId:'thread-current'});
 assert.equal(args.includes('/tmp/repeated.png'),false);
});

test('analysis timeout preserves prior evidence as partial and reopens the original question',()=>{
 const prior={outcome:'needs_clarification',summary:'已确认部分事实',finalMessage:'源码和数据库证据',investigation:{status:'continue',goals:[{id:'original-question',required:true,status:'verified',evidence:'候选原因'}],attempts:[],nextStep:'查日志',blocker:null,causalAssessment:{status:'unknown',link:'unproven',mechanism:'',evidence:[],alternatives:''}},handoff:{artifacts:[{kind:'code',path:'a.js'}],checks:[{id:'original-question',required:true,status:'not_run',evidence:'待查'}],risks:[],returnTo:'none'}};
 const out=analysisTimeoutResult({context:[{kind:'analysis_turn',result:prior}]},new Error('resume timeout'));
 assert.equal(out.outcome,'partial');assert.equal(out.investigation.goals[0].status,'open');assert.match(out.summary,/性能保护/);assert.match(out.handoff.risks.join(' '),/resume timeout/);
});

test('analysis accepts a non-Git project folder and sees ignored and untracked files in child repositories', async (t) => {
  const directory = await fixture(t), root = path.join(directory, 'projects');
  const child = path.join(root, 'business');
  await mkdir(child, { recursive: true });
  await exec('git', ['-C', child, 'init'], { windowsHide: true });
  await writeFile(path.join(child, '.gitignore'), 'local.js\n');
  await writeFile(path.join(child, 'local.js'), 'ignored but relevant source');
  await writeFile(path.join(root, 'notes.md'), 'untracked workspace notes');
  const workspace = await prepareWorkspace(input, { repoPath: root }, path.join(directory, 'trees'));
  assert.equal(await readFile(path.join(workspace, 'business/local.js'), 'utf8'), 'ignored but relevant source');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'untracked workspace notes');
  await assert.rejects(readdir(path.join(root, '.git')), { code: 'ENOENT' });
  await assert.rejects(prepareWorkspace({ ...input, taskIntent: 'implementation' }, { repoPath: root }, path.join(directory, 'trees')));
});

test('ready analysis atomically hands evidence to owner exactly once, without human approval', async (t) => {
  const store = new JsonStore(path.join(await fixture(t), 'store.json'));
  const { job } = await store.createJob(input);
  const leased = await store.leaseNext('runner');
  const event = { type: 'completed', runnerId: 'runner', leaseId: leased.lease.id,
    result: { outcome: 'ready', finalMessage: 'POST /login: sys/login.js:1', workspace: 'D:/demo' } };
  const done = await store.appendEvent(job.id, event, routing);
  assert.equal(done.job.status, 'completed');
  assert.equal(done.nextJob.agentProfile, 'owner');
  assert.equal(done.nextJob.missionId, job.missionId);
  assert.equal(done.nextJob.taskIntent, 'analysis');
  assert.equal(done.nextJob.context[0].result.finalMessage, event.result.finalMessage);
  await assert.rejects(store.appendEvent(job.id, event, routing));
  assert.equal((await store.read()).jobs.length, 2);
  const report = await store.leaseNext('runner');
  assert.equal(report.stage, 'owner_report');
  const final = await store.appendEvent(report.id, { ...event, leaseId: report.lease.id }, routing);
  assert.equal(final.nextJob, null);
  assert.equal(final.job.status, 'completed');
});

test('blocked, clarification, cancellation and implementation never auto-advance this read-only edge', async (t) => {
  for (const kind of ['blocked', 'needs_clarification', 'cancel', 'implementation', 'missing-profile']) {
    const store = new JsonStore(path.join(await fixture(t), 'store.json'));
    const { job } = await store.createJob({ ...input, taskIntent: kind === 'implementation' ? kind : 'analysis' });
    const lease = await store.leaseNext('runner');
    if (kind === 'cancel') await store.cancel(job.id, 'human');
    const result = await store.appendEvent(job.id, { type: 'completed', runnerId: 'runner', leaseId: lease.lease.id,
      result: { outcome: ['blocked', 'needs_clarification'].includes(kind) ? kind : 'ready', finalMessage: 'reason' } }, kind === 'missing-profile' ? {} : routing);
    assert.equal(result.nextJob, null);
    assert.equal((await store.read()).jobs.length, 1);
    if (kind === 'cancel') assert.equal(result.job.status, 'cancelling');
  }
});

test('Runner HTTP completion resolves real owner profile and rejects duplicate event', async (t) => {
  const directory = await fixture(t);
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'store.json'),
    projects: { projects: {}, chatProjectMap: {} }, agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' } } },
    adminToken: 'admin', runnerToken: 'runner', conversationResponder: async () => {},
    feishuClient: { send: async () => ({}), reply: async () => ({}) } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise((r) => app.server.close(r)); await app.conversations.stop(); await app.cards.stop(); });
  const { job } = await app.store.createJob(input);
  const lease = await app.store.leaseNext('runner');
  const url = `http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`;
  const request = () => fetch(url, { method: 'POST', headers: { authorization: 'Bearer runner', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'completed', leaseId: lease.lease.id, runnerId: 'runner', result: { outcome: 'ready', finalMessage: 'Evidence' } }) });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 409);
  const state = await app.store.read();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[1].agentProfile, 'owner');
});

test('card shows real blocker on first screen with sanitized content and visible handoff', () => {
  const job = { ...input, id: 'JOB-example', status: 'blocked', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    result: { finalMessage: '[BLOCKED]\n缺少 sys 业务仓；无法确认控制器。password=verysecret' }, events: [] };
  const card = jobCard(job);
  const first = JSON.stringify(card.body.elements[0]);
  assert.match(first, /缺少 sys 业务仓/);
  assert.doesNotMatch(first, /verysecret/);
  assert.doesNotMatch(first, /需要补充信息，尚未通过/);
  assert.match(JSON.stringify(jobCard({ ...job, status: 'completed', nextJobId: 'JOB-report' })), /已交给项目负责人汇总/);
});

test('ready environment substep returns to original investigation through HTTP and drops query grant',async t=>{
 const dir=await fixture(t);
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'store.json'),conversationFile:path.join(dir,'conversation.json'),memoryFile:path.join(dir,'memory.json'),runnerToken:'test',projects:{projects:{demo:{repoPath:dir,analysisRepositories:[{path:'.'}]}},ownerOpenIdsByProfile:{owner:['ou_admin']}},agents:{agents:{developer:{profile:'dev'},owner_report:{profile:'owner'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const {job}=await app.store.createJob({...input,workflow:'single_developer',questionId:'q',senderId:'ou_member',instruction:'核对实际单据',originalQuestion:'核对实际单据'});
 await app.store.transact(s=>{s.jobs[0].environmentAccess={tier:'uat',environmentId:'nacos',scopeHash:'scope',approvedBy:'ou_admin',startedAt:new Date().toISOString()};});
 const lease=await app.store.leaseNext('runner');
 const body={type:'completed',runnerId:'runner',leaseId:lease.lease.id,result:{outcome:'ready',summary:'仅找到数据库入口',finalMessage:'未查询实际单据',environmentEvidence:{resultHash:'a'.repeat(64)}}};
 const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`;
 const send=()=>fetch(endpoint,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send()).status,200);const state=await app.store.read();assert.equal(state.jobs.length,2);
 const next=state.jobs[1];assert.equal(next.stage,'developer');assert.equal(next.workflow,'analysis_review');assert.equal(next.questionId,'q');assert.equal(next.senderId,'ou_member');assert.equal(next.instruction,'核对实际单据');assert.equal(next.environmentAccess,undefined);assert.equal(next.sourceEnvironment,'uat');assert.equal(next.context.at(-1).result.summary,'仅找到数据库入口');
 assert.equal((await send()).status,409);assert.equal((await app.store.read()).jobs.length,2);
});
