import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, createRunnerPool } from '../src/runner/index.js';
import { runnerConfig } from '../src/runner/config.js';
import { JsonStore } from '../src/shared/store.js';
import { planQuery } from '../src/shared/environment-access.js';

test('continuous analysis keeps source and environment turns inside one leased job', async () => {
  const calls = [];
  const root = { id: 'JOB-one', questionId: 'QST-one', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: 'LEASE-one', runnerId: 'runner-one' }, context: [] };
  const plan = { environmentId: 'uat', queryId: 'investigate', parameters: ['核对订单'], kind: 'mysql' };
  let turn = 0;
  const execute = async (job) => {
    calls.push({ kind: job.environmentAccess ? 'environment' : 'source', id: job.id, context: job.context.length });
    if (job.environmentAccess) return { outcome: 'ready', finalMessage: '查到实际订单', environmentEvidence: { resultHash: 'a'.repeat(64) } };
    if (turn++ === 0) return { outcome: 'needs_clarification', finalMessage: '需要实时数据', environmentQuery: plan };
    return { outcome: 'ready', finalMessage: '结合源码和数据库形成最终结论' };
  };
  const runner = new AgentRunner({ runnerId: 'runner-one' }, execute);
  runner.post = async (url, body) => {
    if (url.endsWith('/continuous-environment')) return { planned: true, job: { ...root, environmentAccess: plan,
      context: [{ stage: 'developer', result: body.result }] } };
    if (url.endsWith('/continuous-environment-result')) return { job: { ...root,
      context: [{ stage: 'developer', result: { threadId: 'thread-one' } }, { stage: 'developer', result: body.result }] } };
    throw new Error(`unexpected ${url}`);
  };
  const result = await runner.executeContinuous(root, async () => {}, new AbortController().signal);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(calls.map((item) => item.kind), ['source', 'environment', 'source']);
  assert.deepEqual(new Set(calls.map((item) => item.id)), new Set(['JOB-one']));
});

test('continuous analysis can start with an environment query and return to the same source thread', async () => {
  const root = { id: 'JOB-database-first', questionId: 'QST-database-first', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: 'LEASE-database-first', runnerId: 'runner-one' }, context: [],
    environmentAccess: { environmentId: 'uat', queryId: 'investigate', parameters: ['核对经销商'], kind: 'mysql' } };
  const calls = [];
  const runner = new AgentRunner({ runnerId: 'runner-one' }, async (job) => {
    calls.push({ id: job.id, kind: job.environmentAccess ? 'environment' : 'source', context: job.context.length });
    return job.environmentAccess
      ? { outcome: 'partial', finalMessage: '数据库确认销售组织为空', environmentEvidence: { resultHash: 'a'.repeat(64) } }
      : { outcome: 'ready', finalMessage: '结合数据库、源码和同批次对照，确认缺少销售组织导致上账失败' };
  });
  runner.post = async (url, body) => {
    assert.ok(url.endsWith('/continuous-environment-result'));
    return { job: { ...root, environmentAccess: undefined,
      context: [{ stage: 'developer', kind: 'environment_result', result: body.result }] } };
  };
  const result = await runner.executeContinuous(root, async () => {}, new AbortController().signal);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(calls.map((item) => item.kind), ['environment', 'source']);
  assert.deepEqual(new Set(calls.map((item) => item.id)), new Set(['JOB-database-first']));
  assert.equal(calls[1].context, 1);
});

test('a failed supplementary environment read preserves verified source findings as an orange partial result', async () => {
  const root = { id: 'JOB-preserve', questionId: 'QST-preserve', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: 'LEASE-preserve', runnerId: 'runner-one' }, context: [] };
  const plan = { environmentId: 'uat-web', queryId: 'investigate', parameters: ['核对页面计算'], kind: 'website' };
  const source = { outcome: 'needs_clarification', summary: '源码已确认两个费比口径',
    finalMessage: '通过后费比与基础费用使用比例的公式已经从源码确认。', websiteQuery: { url: 'https://business.example/app', tier: 'uat', purpose: '核对页面计算' },
    investigation: { status: 'continue', blocker: null, goals: [{ id: 'original-question', required: true, status: 'open', evidence: '源码公式已确认，页面数值待核对' }] },
    handoff: { artifacts: [{ kind: 'code', path: 'service.js' }], checks: [{ id: 'formula', required: false, status: 'passed', evidence: '源码公式已核对' }], risks: ['页面数值未核对'], returnTo: 'none' },
    verifiedArtifacts: [{ path: 'service.js' }], handoffGate: { passed: true } };
  let calls = 0;
  const runner = new AgentRunner({ runnerId: 'runner-one' }, async (job) => {
    calls++;
    return job.environmentAccess
      ? { outcome: 'blocked', summary: '网页读取失败', finalMessage: '错误码：BROWSER_BRIDGE\n失败环节：日常浏览器接管' }
      : source;
  });
  runner.post = async (url, body) => {
    assert.ok(url.endsWith('/continuous-environment'));
    return { planned: true, job: { ...root, environmentAccess: plan,
      context: [{ stage: 'developer', kind: 'analysis_turn', result: body.result }] } };
  };
  const result = await runner.executeContinuous(root, async () => {}, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(result.outcome, 'partial');
  assert.match(result.finalMessage, /两个费比口径|公式已经从源码确认/);
  assert.match(result.finalMessage, /BROWSER_BRIDGE/);
  assert.equal(result.handoffGate.passed, true);
  assert.equal(result.investigation.status, 'wait');
});

test('a failed environment read remains blocked when no verified prior finding exists', async () => {
  const root = { id: 'JOB-no-evidence', questionId: 'QST-no-evidence', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: 'LEASE-no-evidence', runnerId: 'runner-one' }, context: [] };
  const blocked = { outcome: 'blocked', summary: '连接失败', finalMessage: '错误码：NETWORK' };
  const runner = new AgentRunner({ runnerId: 'runner-one' }, async () => blocked);
  assert.equal(await runner.executeContinuous({ ...root, environmentAccess: { kind: 'website' } }, async () => {}, new AbortController().signal), blocked);
});

test('continuous analysis automatically resumes a partial investigation without asking the user to say continue', async () => {
  const root = { id: 'JOB-deep', questionId: 'QST-deep', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: 'LEASE-deep', runnerId: 'runner-one' }, context: [] };
  const calls = [];
  const runner = new AgentRunner({ runnerId: 'runner-one' }, async (job) => {
    calls.push(job.context.length);
    if (!job.context.length) return { outcome: 'partial', finalMessage: '只确认了告警触发条件',
      investigation: { status: 'continue', blocker: null, goals: [{ id: 'original-question', status: 'open', evidence: '触发条件已确认' }] } };
    return { outcome: 'ready', finalMessage: '已继续查清异常状态形成原因', investigation: { status: 'complete', blocker: null } };
  });
  runner.post = async (url, body) => {
    assert.ok(url.endsWith('/continuous-analysis-continue'));
    return { continued: true, job: { ...root, context: [{ stage: 'developer', kind: 'analysis_turn', result: body.result }] } };
  };
  const result = await runner.executeContinuous(root, async () => {}, new AbortController().signal);
  assert.equal(result.outcome, 'ready');assert.deepEqual(calls, [0, 1]);
});

test('runner pool provides bounded unique parallel execution slots', async () => {
  const config = await runnerConfig({ projects: {}, runnerId: 'mac-mini', concurrency: 3 });
  assert.equal(config.analysisTurnTimeoutMs,900000);assert.equal(config.analysisResumeTimeoutMs,480000);
  let active = 0, peak = 0;
  const pool = createRunnerPool(config, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return { outcome: 'ready' };
  });
  assert.deepEqual(pool.map((runner) => runner.config.runnerId), ['mac-mini-1', 'mac-mini-2', 'mac-mini-3']);
  await Promise.all(pool.map((runner, index) => runner.executeContinuous({
    id: `JOB-${index + 1}`, questionId: `QST-${index + 1}`, projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
    continuousInvestigation: true, lease: { id: `LEASE-${index + 1}`, runnerId: runner.config.runnerId }, context: [],
  }, async () => {}, new AbortController().signal)));
  assert.equal(peak, 3);
  await assert.rejects(runnerConfig({ projects: {}, concurrency: 9 }), /1 to 8/);
  await assert.rejects(runnerConfig({projects:{},analysisResumeTimeoutMs:1000}),/60000\.\.1800000/);
});

test('continuous environment evidence stays on the same job and final completion creates no successor', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-continuous-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = process.env.AGENTOS_ENVIRONMENTS_FILE;
  process.env.AGENTOS_ENVIRONMENTS_FILE = path.join(directory, 'environments.json');
  t.after(() => { if (old) process.env.AGENTOS_ENVIRONMENTS_FILE = old; else delete process.env.AGENTOS_ENVIRONMENTS_FILE; });
  const environments = { version: 1, environments: { uat: { projectId: 'demo', tier: 'uat', kind: 'mysql', host: 'db.test', port: 3306,
    database: 'demo', credentialRef: 'uat', membersRead: true, ownerOpenIdsByProfile: { owner: ['ou_admin'] },
    queries: { investigate: { reviewed: true, mode: 'investigate', description: '只读核对订单', tables: ['orders'], maxRows: 20,
      timeoutMs: 5000, parameters: [{ name: 'purpose', type: 'string', maxLength: 200 }] } } } } };
  await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE, JSON.stringify(environments));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const { job } = await store.createJob({ projectId: 'demo', questionId: 'QST-one', chatId: 'group', senderId: 'member', originProfile: 'owner',
    taskIntent: 'analysis', workflow: 'continuous_analysis', stage: 'developer', instruction: '核对订单', continuousInvestigation: true });
  const leased = await store.leaseNext('runner');
  const identity = { runnerId: 'runner', leaseId: leased.lease.id };
  const plan = planQuery(environments, { environmentId: 'uat', queryId: 'investigate', parameters: ['核对订单'] }, 'demo', { profile: 'owner', senderId: 'member' });
  await store.beginContinuousEnvironment(job.id, identity, plan, { outcome: 'needs_clarification', finalMessage: '需要数据库证据', environmentQuery: {} });
  const claimed = await store.claimEnvironment(job.id, identity);
  const evidence = { environmentId: 'uat', queryId: 'investigate', scopeHash: claimed.scopeHash,
    readAt: new Date(Date.now() + 1).toISOString(), rowCount: 1, resultHash: 'a'.repeat(64) };
  const resumed = await store.completeContinuousEnvironment(job.id, identity,
    { outcome: 'ready', finalMessage: '已读取订单', environmentEvidence: evidence });
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.environmentAccess, undefined);
  assert.equal(resumed.context.length, 2);
  const done = await store.appendEvent(job.id, { type: 'completed', ...identity,
    result: { outcome: 'ready', finalMessage: '最终结论' } });
  assert.equal(done.job.status, 'completed');
  assert.equal(done.nextJob, null);
  assert.equal((await store.read()).jobs.length, 1);
});

test('store checkpoints one partial analysis turn on the same lease and rejects unchanged repetition', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-continuous-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const { job } = await store.createJob({ projectId: 'demo', questionId: 'QST-review', chatId: 'group', senderId: 'member', originProfile: 'owner',
    taskIntent: 'analysis', workflow: 'continuous_analysis', stage: 'developer', instruction: '深度排查', continuousInvestigation: true });
  const leased = await store.leaseNext('runner');
  const identity = { runnerId: 'runner', leaseId: leased.lease.id };
  const partial = { outcome: 'partial', finalMessage: '告警触发已确认，上游原因待查',
    investigation: { status: 'continue', blocker: null, goals: [{ id: 'original-question', status: 'open', evidence: '告警触发已确认' }] } };
  const first = await store.continueContinuousAnalysis(job.id, identity, partial);
  assert.equal(first.continued, true);assert.equal(first.job.context.length, 1);assert.equal(first.job.status, 'running');
  const repeated = await store.continueContinuousAnalysis(job.id, identity, partial);
  assert.equal(repeated.continued, false);assert.equal(repeated.terminalResult.finalMessage, partial.finalMessage);
  assert.equal((await store.getJob(job.id)).context.length, 1);
});

test('continuous environment accepts evidence returned shortly after tool expiry when the final read was authorized', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-continuous-expiry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = process.env.AGENTOS_ENVIRONMENTS_FILE;
  process.env.AGENTOS_ENVIRONMENTS_FILE = path.join(directory, 'environments.json');
  t.after(() => { if (old) process.env.AGENTOS_ENVIRONMENTS_FILE = old; else delete process.env.AGENTOS_ENVIRONMENTS_FILE; });
  const environments = { version: 1, environments: { uat: { projectId: 'demo', tier: 'uat', kind: 'mysql', host: 'db.test', port: 3306,
    database: 'demo', credentialRef: 'uat', membersRead: true, ownerOpenIdsByProfile: { owner: ['ou_admin'] },
    queries: { investigate: { reviewed: true, mode: 'investigate', description: '只读核对订单', tables: ['orders'], maxRows: 20,
      timeoutMs: 5000, parameters: [{ name: 'purpose', type: 'string', maxLength: 200 }] } } } } };
  await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE, JSON.stringify(environments));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const { job } = await store.createJob({ projectId: 'demo', questionId: 'QST-expiry', chatId: 'group', senderId: 'member', originProfile: 'owner',
    taskIntent: 'analysis', workflow: 'continuous_analysis', stage: 'developer', instruction: '核对订单', continuousInvestigation: true });
  const leased = await store.leaseNext('runner');
  const identity = { runnerId: 'runner', leaseId: leased.lease.id };
  const plannedAt = Date.now() - 15 * 60000 - 90_000;
  const plan = planQuery(environments, { environmentId: 'uat', queryId: 'investigate', parameters: ['核对订单'] }, 'demo', { profile: 'owner', senderId: 'member' }, plannedAt);
  plan.startedAt = new Date(plannedAt + 1000).toISOString();
  await store.beginContinuousEnvironment(job.id, identity, plan, { outcome: 'needs_clarification', finalMessage: '需要数据库证据', environmentQuery: {} });
  const result = { outcome: 'ready', finalMessage: '已读取订单', environmentEvidence: { environmentId: 'uat', queryId: 'investigate', scopeHash: plan.scopeHash,
    readAt: new Date().toISOString(), lastAuthorizedAt: new Date(Date.parse(plan.expiresAt) - 1000).toISOString(), rowCount: 1, resultHash: 'b'.repeat(64) } };
  const resumed = await store.completeContinuousEnvironment(job.id, identity, result);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.environmentAccess, undefined);
});
