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

test('runner pool provides bounded unique parallel execution slots', async () => {
  const config = await runnerConfig({ projects: {}, runnerId: 'mac-mini', concurrency: 3 });
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
