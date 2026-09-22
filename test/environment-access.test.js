import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planQuery, verifyPlan, loadEnvironments, catalog } from '../src/shared/environment-access.js';
import { mysqlRead, nacosRead, databaseEndpoints, assertReadOnlyGrants, readEnvironment } from '../src/runner/environment-connector.js';
import { createControlPlane } from '../src/control-plane/server.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { jobActionVersion } from '../src/control-plane/message-cards.js';
import { publishQuestion } from '../src/control-plane/questions.js';
import { memorySources } from '../src/control-plane/memory.js';
const config = () => ({ version: 1, environments: { prd: { projectId: 'demo', tier: 'prd', kind: 'mysql', host: '127.0.0.1', port: 3306, database: 'demo', credentialRef: 'demo_readonly', membersRead: false,
  ownerOpenIdsByProfile: { owner: ['ou_owner'] }, queries: { order: { reviewed: true, description: '按订单号查询状态', sql: 'SELECT order_id, status FROM orders WHERE order_id = ?',
    parameters: [{ name: 'orderId', type: 'string', maxLength: 40 }], outputColumns: ['order_id', 'status'], maxRows: 5, timeoutMs: 1000 } } } } });
const request = { environmentId: 'prd', queryId: 'order', parameters: ['ORDER-1'] };
const actor = { profile: 'owner', senderId: 'ou_member' };
const decision = (extra = {}) => ({ reply: '申请只读查询', action: 'create_task', intent: 'analysis', instruction: '检查订单状态', jobId: '', projectId: '', attachmentIds: [], requiresSourceInspection: false, environmentQuery: request, ...extra });
async function fixture(t, responder = () => decision()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-environment-test-'));
  const previous = process.env.AGENTOS_ENVIRONMENTS_FILE; process.env.AGENTOS_ENVIRONMENTS_FILE = path.join(dir, 'environments.json');
  const cfg = config(); await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE, JSON.stringify(cfg));
  const calls = [];
  const client = { replyCard: async (id, card) => { calls.push({ type: 'card', card }); return { message_id: `synthetic-card-${calls.length}` }; }, updateCard: async (id, card) => calls.push({ type: 'update', card }), reply: async (id, text) => calls.push({ type: 'text', text }) };
  const app = await createControlPlane({ runnerToken: 'synthetic-runner', dataDir: dir, storeFile: path.join(dir, 'state.json'),
    projects: { projects: { demo: {} }, chatProjectMap: { group: 'demo' }, ownerOpenIdsByProfile: { owner: ['ou_owner', 'ou_otherAdmin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'developer' } } },
    feishuClient: client, conversationOptions: { groupSessions: true, questionCards: true }, conversationResponder: responder });
  const context = { ...app, feishu: client };
  async function send(sender = 'ou_member', extra = {}) { await app.conversations.enqueue({ message_id: `m${Math.random()}`, chat_id: 'group', chat_type: 'group', sender_id: sender, agent_profile: 'owner', agent_role: 'owner_intake', content: '查询订单', ...extra }); await app.conversations.idle(); }
  t.after(async () => { await new Promise(resolve => setImmediate(resolve));
    for (const q of Object.keys((await app.store.read()).questions ?? {})) await publishQuestion(context, q);
    if (app.server.listening) await new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); });
    await app.conversations.stop(); await app.cards.stop(); if (previous === undefined) delete process.env.AGENTOS_ENVIRONMENTS_FILE; else process.env.AGENTOS_ENVIRONMENTS_FILE = previous; await rm(dir, { recursive: true, force: true }); });
  return { app, context, calls, send, cfg, dir };
}
test('reviewed read-only queries auto-authorize for members in UAT and PRD', () => {
  const cfg = config(); const plan = planQuery(cfg, request, 'demo', actor, 1000);
  assert.equal(plan.approvalRequired, false); assert.equal(plan.approvedBy, 'policy:read-only');
  assert.equal(planQuery(cfg, request, 'demo', { ...actor, senderId: 'ou_owner' }).approvedBy, 'policy:read-only');
  cfg.environments.prd.tier = 'uat'; cfg.environments.prd.membersRead = true;
  assert.equal(planQuery(cfg, request, 'demo', actor).approvedBy, 'policy:read-only');
  assert.throws(() => planQuery(cfg, request, 'other', actor));
});
test('startup reconciliation resumes legacy read-only approval jobs once', async (t) => {
  const { app, cfg } = await fixture(t);
  const plan = planQuery(cfg, request, 'demo', actor);
  const { job } = await app.store.createJob({ projectId: 'demo', chatId: 'group', senderId: 'ou_member', originProfile: 'owner', questionId: 'q', stage: 'developer', workflow: 'single_developer', taskIntent: 'analysis', instruction: '查询订单', status: 'awaiting_environment_approval', environmentAccess: { ...plan, approvalRequired: true, approvedBy: null, approvedAt: null } });
  assert.deepEqual(await app.store.reconcileReadOnlyApprovals(), { resumed: 1 });
  const resumed = await app.store.getJob(job.id);
  assert.equal(resumed.status, 'queued'); assert.equal(resumed.environmentAccess.approvedBy, 'policy:read-only');
  assert.equal(resumed.events.filter(e => e.type === 'environment_policy_authorized').length, 1);
  assert.deepEqual(await app.store.reconcileReadOnlyApprovals(), { resumed: 0 });
});
test('approval scope binds parameters, configuration and deadline', () => {
  const cfg = config(), plan = planQuery(cfg, request, 'demo', actor, 1000);
  assert.equal(verifyPlan(cfg, plan, 2000).kind, 'mysql');
  assert.throws(() => verifyPlan(cfg, { ...plan, parameters: ['another'] }, 2000));
  assert.throws(() => verifyPlan(cfg, { ...plan, expiresAt: 'invalid' }, 2000));
  assert.throws(() => verifyPlan(cfg, { ...plan, expiresAt: new Date(9000000).toISOString() }, 2000));
  assert.throws(() => verifyPlan(cfg, plan, 1000000));
  cfg.environments.prd.host = 'another-host'; assert.throws(() => verifyPlan(cfg, plan, 2000));
  assert.throws(() => planQuery(config(), { ...request, parameters: [{ sql: 'SELECT anything' }] }, 'demo', actor));
});
test('configuration accepts PRD read policy but rejects secrets, SQL writes and unreviewed templates', async (t) => {
  const { dir } = await fixture(t); const file = path.join(dir, 'invalid.json');
  const allowed = config(); allowed.environments.prd.membersRead = true; await writeFile(file, JSON.stringify(allowed)); await loadEnvironments(file);
  for (const mutate of [c => c.environments.prd.password = 'synthetic', c => c.environments.prd.queries.order.reviewed = false,
    c => c.environments.prd.queries.order.sql = 'SELECT * FROM orders; DELETE FROM orders', c => c.environments.prd.queries.order.outputColumns = ['password']]) {
    const c = config(); mutate(c); await writeFile(file, JSON.stringify(c)); await assert.rejects(loadEnvironments(file));
  }
  const view = JSON.stringify(catalog(config(), 'demo')); assert.doesNotMatch(view, /127\.0|credentialRef|ou_owner|FROM orders/);
});
test('member PRD read request is immediately leasable and can only be claimed once', async (t) => {
  const { app, send, calls } = await fixture(t); await send();
  const state = await app.store.read(); const job = state.jobs[0];
  assert.equal(job.status, 'queued'); assert.equal(job.environmentAccess.approvedBy, 'policy:read-only');
  assert.equal(job.workflow, 'continuous_analysis'); assert.equal(job.continuousInvestigation, true);
  assert.doesNotMatch(JSON.stringify(calls), /批准本次只读查询|请审核原卡中的环境/);
  const leased = await app.store.leaseNext('r'); const identity = { leaseId: leased.lease.id, runnerId: 'r' };
  const plan = await app.store.claimEnvironment(job.id, identity); assert.ok(plan.startedAt);
  await assert.rejects(app.store.claimEnvironment(job.id, identity));
  assert.equal((await app.store.read()).jobs[0].events.filter(e => e.type === 'environment_query_started').length, 1);
});
test('cancel, changed config, expired grant and wrong lease never reach connector claim', async (t) => {
  const { app, send, cfg } = await fixture(t); await send('ou_owner'); const j = (await app.store.read()).jobs[0];
  const leased = await app.store.leaseNext('r'); const identity = { leaseId: leased.lease.id, runnerId: 'r' };
  await assert.rejects(app.store.claimEnvironment(j.id, { ...identity, runnerId: 'foreign' }));
  cfg.environments.prd.queries.order.maxRows = 2; await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE, JSON.stringify(cfg));
  await assert.rejects(app.store.claimEnvironment(j.id, identity));
  await app.store.cancel(j.id, 'ou_owner'); await assert.rejects(app.store.claimEnvironment(j.id, identity));
});
test('MySQL only uses reviewed parameter binding, read-only transaction, bounded results and whitelisted columns', async () => {
  const cfg = config(), e = cfg.environments.prd, q = e.queries.order, calls = [];
  const conn = { query: async (s) => { calls.push(s); return [[{ grant: 'GRANT SELECT ON `demo`.* TO `reader`@`%`' }]]; },
    execute: async (sql, params) => { calls.push({ sql, params }); return [[{ order_id: 'a', status: 'ready', password: 'never-expose' }]]; }, rollback: async () => { calls.push('rollback'); }, destroy: () => calls.push('destroy') };
  const value = await mysqlRead(e, q, ["a' OR 1=1"], { username: 'synthetic-reader', password: 'synthetic-secret' }, { mysql: { createConnection: async (options) => { assert.equal(options.multipleStatements, false); return conn; } } });
  assert.ok(calls.includes('START TRANSACTION READ ONLY'));
  assert.deepEqual(value.rows, [{ order_id: 'a', status: 'ready' }]);
  const execution = calls.find(c => c.sql); assert.deepEqual(execution.params, ["a' OR 1=1"]); assert.doesNotMatch(execution.sql.sql, /OR 1=1/); assert.match(execution.sql.sql, /LIMIT 6$/);
  assert.equal(calls.at(-1), 'destroy');
  for (const grant of ['GRANT ALL PRIVILEGES ON *.* TO reader', 'GRANT SELECT, INSERT ON demo.* TO reader', 'GRANT `role_reader` TO reader', 'GRANT SELECT ON demo.* TO reader WITH GRANT OPTION']) assert.throws(() => assertReadOnlyGrants([{ grant }]));
});
test('Nacos connector only authenticates and reads exact config, never returns password or JDBC query parameters', async () => {
  const requests = [], e = { baseUrl: 'http://127.0.0.1:8848/nacos' }, q = { dataId: 'application.properties', group: 'DEFAULT_GROUP', namespace: 'demo', maxRows: 2, timeoutMs: 1000 };
  const r = await nacosRead(e, q, { username: 'synthetic-user', password: 'synthetic-password' }, { fetch: async (url, options) => {
    requests.push({ url: String(url), method: options.method ?? 'GET' });
    return requests.length === 1 ? '{"accessToken":"synthetic-token"}' : 'spring.datasource.url=jdbc:mysql://db.example:3306/demo?password=synthetic-password\npassword=synthetic-password';
  } });
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[1].method, 'GET');
  assert.deepEqual(r.rows, [{ server: 'db.example:3306', host: 'db.example', port: 3306, database: 'demo', driver: 'mysql' }]);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-password|synthetic-token/);
  assert.deepEqual(databaseEndpoints('password=do-not-return'), []);
});
test('connector failures redact remote errors; invalid policy performs no credential lookup', async () => {
  const cfg = config(), plan = planQuery(cfg, request, 'demo', actor); let reads = 0;
  await assert.rejects(readEnvironment({ ...plan, approvedBy: null }, { config: cfg, credential: async () => { reads++; } }), /尚未批准/); assert.equal(reads, 0);
  await assert.rejects(readEnvironment(plan, { config: cfg, credential: async () => { throw new Error('remote password=SYNTHETIC_SECRET'); } }), e => !e.message.includes('SYNTHETIC_SECRET'));
});
test('environment rows are excluded from legacy memory and shared group task context', async (t) => {
  const { app, send } = await fixture(t); await send('ou_owner');
  await app.store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = { summary: 'sensitive-row-marker', finalMessage: 'sensitive-row-marker' }; });
  const s = await app.store.read(), turn = s.conversations[0];
  assert.doesNotMatch(JSON.stringify(memorySources(s, turn, 'demo')), /sensitive-row-marker/);
  const input = await app.conversations.buildInput(turn); assert.doesNotMatch(JSON.stringify(input), /sensitive-row-marker/);
});
test('source analysis atomically continues into an auto-authorized read query', async (t) => {
  const { app, send } = await fixture(t, () => decision({ environmentQuery: null, requiresSourceInspection: true }));
  await send('ou_owner'); const source = (await app.store.read()).jobs[0];
  const leased = await app.store.leaseNext('r');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const post = () => fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${source.id}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${app.config.runnerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'completed', leaseId: leased.lease.id, runnerId: 'r',
      result: { outcome: 'needs_clarification', summary: '需要订单当前状态', finalMessage: '已确认源码条件，需要环境数据验证', environmentQuery: request } }) });
  assert.equal((await post()).status, 200);
  let state = await app.store.read(); assert.equal(state.jobs.length, 2);
  const next = state.jobs[1]; assert.equal(next.questionId, source.questionId); assert.equal(next.senderId, 'ou_owner');
  assert.equal(next.status, 'queued'); assert.equal(next.environmentAccess.approvedBy, 'policy:read-only');
  assert.equal(state.jobs[0].nextJobId, next.id); assert.equal(state.jobs[0].status, 'completed');
  assert.equal((await app.store.leaseNext('r')).id, next.id); assert.equal((await post()).status, 409);
  state = await app.store.read(); assert.equal(state.jobs.length, 2);
});
test('invalid analysis escalation fails closed without creating a query successor', async (t) => {
  const { app, send } = await fixture(t, () => decision({ environmentQuery: null, requiresSourceInspection: true }));
  await send(); const leased = await app.store.leaseNext('r');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${leased.id}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${app.config.runnerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'completed', leaseId: leased.lease.id, runnerId: 'r', result: {
      outcome: 'needs_clarification', environmentQuery: { ...request, queryId: 'notConfigured' } } }) });
  assert.equal(response.status, 200); const state = await app.store.read();
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'blocked');
  assert.equal(await app.store.leaseNext('r'), null);
});

test('expired Runner lease cannot claim an otherwise approved query', async (t) => {
  const { app, send } = await fixture(t); await send('ou_owner'); const j = await app.store.leaseNext('r');
  await app.store.transact(s => { s.jobs[0].lease.expiresAt = new Date(Date.now() - 1).toISOString(); });
  await assert.rejects(app.store.claimEnvironment(j.id, { leaseId: j.lease.id, runnerId: 'r' }));
  assert.equal((await app.store.getJob(j.id)).environmentAccess.startedAt, undefined);
});
test('connector rejects an approver outside the current environment owner map', async () => {
  const plan = planQuery(config(), request, 'demo', { ...actor, senderId: 'ou_owner' }); let lookedUp = false;
  await assert.rejects(readEnvironment({ ...plan, approvedBy: 'ou_otherAdmin' }, { config: config(), credential: async () => { lookedUp = true; } }));
  assert.equal(lookedUp, false);
});

test('owner report can request runtime evidence rather than ending a partial source investigation', async t => {
 const {app,send}=await fixture(t,()=>decision({environmentQuery:null,requiresSourceInspection:true}));
 await send('ou_owner');
 await app.store.transact(s=>{s.jobs[0].stage='owner_report';s.jobs[0].workflow='owner_report';});
 const job=await app.store.leaseNext('r');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const post=()=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`,{method:'POST',headers:{authorization:`Bearer ${app.config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({type:'completed',leaseId:job.lease.id,runnerId:'r',result:{outcome:'needs_clarification',environmentQuery:request,summary:'需要实时数据',finalMessage:'源码已确认，需要环境验证'}})});
 assert.equal((await post()).status,200);const state=await app.store.read();assert.equal(state.jobs.length,2);
 assert.equal(state.jobs[1].status,'queued');assert.equal(state.jobs[1].questionId,job.questionId);
 assert.equal(state.jobs[1].originalQuestion,'查询订单');assert.equal(state.jobs[1].environmentAccess.approvedBy,'policy:read-only');
 assert.equal((await post()).status,409);
});

test('partial runtime evidence resumes source investigation with original question and without a copied grant',async t=>{
 const {app,send}=await fixture(t);app.projects.projects.demo.analysisRepositories=[{path:'configured',branch:'prd'}];
 await send('ou_owner');const job=await app.store.leaseNext('r');
 const p=await app.store.claimEnvironment(job.id,{runnerId:'r',leaseId:job.lease.id});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const post=()=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`,{method:'POST',headers:{authorization:`Bearer ${app.config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({type:'completed',leaseId:job.lease.id,runnerId:'r',result:{outcome:'partial',summary:'仍需结合代码',finalMessage:'已查到订单，原因未明',environmentEvidence:{environmentId:p.environmentId,queryId:p.queryId,scopeHash:p.scopeHash,readAt:new Date().toISOString(),rowCount:1,resultHash:'a'.repeat(64)}}})});
 assert.equal((await post()).status,200);const state=await app.store.read();const next=state.jobs[1];
 assert.equal(next.stage,'developer');assert.equal(next.workflow,'analysis_review');assert.equal(next.status,'queued');assert.equal(next.environmentAccess,undefined);
 assert.equal(next.sourceEnvironment,'prd');assert.equal(next.instruction,'查询订单');assert.equal(next.questionId,job.questionId);
 assert.equal(next.context.at(-1).result.environmentEvidence.resultHash,'a'.repeat(64));
 assert.equal((await post()).status,409);
});

test('continuation cannot re-request identical environment scope from the same question',async t=>{
 const {app,send}=await fixture(t,()=>decision({environmentQuery:null,requiresSourceInspection:true}));await send('ou_owner');
 await app.store.transact(s=>{s.jobs.push({...structuredClone(s.jobs[0]),id:'prior-runtime',status:'completed',environmentAccess:{...request},result:{summary:'prior evidence'}});});
 const job=await app.store.leaseNext('r');await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`,{method:'POST',headers:{authorization:`Bearer ${app.config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({type:'completed',leaseId:job.lease.id,runnerId:'r',result:{outcome:'needs_clarification',environmentQuery:request}})});
 assert.equal(r.status,200);const state=await app.store.read();assert.equal(state.jobs.length,3);assert.equal(state.jobs[0].status,'completed');assert.equal(state.jobs[0].result.queryRejection.code,'DUPLICATE_QUERY');assert.equal(state.jobs[2].status,'queued');assert.equal(state.jobs[2].environmentAccess,undefined);assert.equal(state.jobs.filter(j=>j.environmentAccess).length,1);
});
