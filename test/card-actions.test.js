import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/shared/store.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { jobCard, jobActionVersion } from '../src/control-plane/message-cards.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { createControlPlane, notifyJobEvent } from '../src/control-plane/server.js';
import { AgentRunner } from '../src/runner/index.js';
import { executeTaskProcess } from '../src/runner/task-process.js';

async function setup(t, autoCleanup = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-action-test-'));
  const store = new JsonStore(path.join(directory, 'store.json'));
  let sequence = 0;
  const notices = [];
  const feishu = { sendCard: async () => ({ message_id: `om_${++sequence}` }), replyCard: async () => ({ message_id: `om_${++sequence}` }),
    updateCard: async () => {}, reply: async (...args) => { notices.push(args); } };
  const cards = new LiveCards(store, feishu, { intervalMs: 0 });
  const context = { store, cards, feishu, projects: { ownerOpenIdsByProfile: { owner: ['admin'], pm: ['admin-pm'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, pm: { profile: 'pm' } } } };
  context.notifyJobEvent = (result) => notifyJobEvent(context, result);
  const create = async (status = 'awaiting_clarification', taskIntent = 'implementation') => {
    const { job } = await store.createJob({ stage: 'owner_intake', agentProfile: 'owner', originProfile: 'owner', senderId: 'creator',
      chatId: 'group', projectId: 'demo', projectName: 'demo', workflow: 'full_delivery', taskIntent, instruction: '原始要求', status });
    const key = `job:${job.id}:first`;
    const messageId = await cards.upsert(key, jobCard(job), { chatId: 'group', replyTo: null, profile: 'owner' },
      { terminal: !['queued', 'running'].includes(status), immediate: true });
    const event = (action, extra = {}) => ({ type: 'card.action.trigger', event_id: `event-${++sequence}`, operator_id: 'creator',
      chat_id: 'group', message_id: messageId, agent_profile: 'owner', card_content: JSON.stringify(jobCard(job)),
      action_value: JSON.stringify({ action, version: jobActionVersion(job) }), ...extra });
    return { job, key, event };
  };
  if (autoCleanup) t.after(async () => { await cards.stop(); await rm(directory, { recursive: true, force: true }); });
  return { context, create, store, cards, directory, feishu, notices };
}

test('waiting card has bounded form and state-specific buttons, no callbacks on form submit', () => {
  const job = { id: 'JOB-test', stage: 'owner_intake', events: [], status: 'awaiting_clarification', createdAt: new Date().toISOString() };
  const card = jobCard(job);
  const form = card.body.elements.find((e) => e.tag === 'form');
  assert.equal(form.elements[0].required, true);
  assert.equal(form.elements[0].max_length, 1000);
  assert.equal(form.elements[1].behaviors, undefined);
  assert.match(form.elements[1].name, /^clarify_/);
  assert.ok(card.body.elements.length <= 5);
  assert.doesNotMatch(JSON.stringify(jobCard({ ...job, status: 'cancelled' })), /"tag":"button"/);
});

test('clarification is atomic, duplicate event retries do not rerun, old card cannot cancel new attempt', async (t) => {
  const { context, create, store } = await setup(t);
  const { job, event } = await create('awaiting_clarification', 'analysis');
  const submit = event('clarify', { action_name: `clarify_${jobActionVersion(job)}`, form_value: JSON.stringify({ clarification: '允许只读分析路径 D:/demo' }) });
  assert.equal((await handleCardAction(context, submit)).ok, true);
  assert.equal((await handleCardAction(context, submit)).ok, true);
  const updated = await store.getJob(job.id);
  assert.equal(updated.status, 'queued');
  assert.equal(updated.events.filter((e) => e.type === 'clarification_received').length, 1);
  assert.equal((await handleCardAction(context, event('cancel'))).ok, false);
  assert.equal((await store.getJob(job.id)).status, 'queued');
});

test('ordinary creator cannot continue implementation from a clarification card; administrator can', async (t) => {
  const { context, create, store } = await setup(t);
  const { job, event } = await create('awaiting_clarification', 'implementation');
  const submit = (operatorId) => event('clarify', { operator_id: operatorId,
    action_name: `clarify_${jobActionVersion(job)}`, form_value: JSON.stringify({ clarification: '继续修改登录接口' }) });
  assert.equal((await handleCardAction(context, submit('creator'))).ok, false);
  assert.equal((await store.getJob(job.id)).status, 'awaiting_clarification');
  assert.equal((await handleCardAction(context, submit('admin'))).ok, true);
  assert.equal((await store.getJob(job.id)).status, 'queued');
});

test('reject stranger, cross-profile and cross-chat; creator cannot approve; administrator can approve only once', async (t) => {
  const { context, create, store } = await setup(t);
  const { job, event } = await create('awaiting_approval');
  assert.equal((await handleCardAction(context, event('approve'))).ok, false);
  assert.equal((await handleCardAction(context, event('cancel', { operator_id: 'stranger' }))).ok, false);
  assert.equal((await handleCardAction(context, event('cancel', { agent_profile: 'pm', operator_id: 'admin-pm' }))).ignored, true);
  assert.equal((await handleCardAction(context, event('cancel', { chat_id: 'other' }))).ignored, true);
  const approve = event('approve', { operator_id: 'admin' });
  assert.equal((await handleCardAction(context, approve)).ok, true);
  assert.equal((await handleCardAction(context, approve)).ok, true);
  assert.equal((await store.read()).jobs.length, 2);
  assert.equal((await store.getJob(job.id)).status, 'completed');
  assert.equal((await store.read()).jobs[1].agentProfile, 'pm');
});

test('queued cancellation prevents lease; late completion and stale lease cannot revive a task', async (t) => {
  const { context, create, store } = await setup(t);
  const { job, event } = await create('queued');
  assert.equal((await handleCardAction(context, event('cancel'))).ok, true);
  assert.equal(await store.leaseNext('runner'), null);
  await assert.rejects(store.appendEvent(job.id, { type: 'completed', result: { outcome: 'ready' } }), /terminal/);
  const { job: running } = await create('queued');
  const leased = await store.leaseNext('runner');
  await store.cancel(running.id, 'creator', 'cancel-running');
  await assert.rejects(store.appendEvent(running.id, { type: 'cancelled', runnerId: 'other', leaseId: leased.lease.id, processesExited: true }), /lease/);
  assert.equal((await store.getJob(running.id)).status, 'cancelling');
});

test('expired lease requests stop instead of spawning a second worker', async (t) => {
  const { create, store } = await setup(t);
  const { job } = await create('queued');
  await store.leaseNext('old', [], -1);
  assert.equal(await store.leaseNext('new'), null);
  assert.equal((await store.getJob(job.id)).status, 'cancelling');
});

test('HTTP callback -> cancellation poll -> actual worker AND descendant exit -> cancelled card', { timeout: 20000 }, async (t) => {
  const { directory, feishu, cards: fixtureCards } = await setup(t, false);
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'integration.json'),
    adminToken: 'test-admin', runnerToken: 'test-runner',
    projects: { projects: { demo: {} }, chatProjectMap: { group: 'demo' }, ownerOpenIdsByProfile: { owner: ['admin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' } } }, feishuClient: feishu,
    conversationResponder: async () => ({ action: 'reply', reply: 'unused' }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { job } = await app.store.createJob({ stage: 'owner_intake', agentProfile: 'owner', originProfile: 'owner', senderId: 'creator',
    chatId: 'group', projectId: 'demo', projectName: 'demo', workflow: 'full_delivery', instruction: 'fixture only' });
  const leased = await app.store.leaseNext('test-worker');
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  const fixture = fileURLToPath(new URL('../test-support/cancellable-worker.mjs', import.meta.url));
  const runner = new AgentRunner({ serverUrl: base, runnerToken: 'test-runner', runnerId: 'test-worker' },
    (job, config, emit, signal) => executeTaskProcess(job, config, async (event) => {
      if (event.type === 'fixture_ready') signalReady(event);
      await emit(event);
    }, signal, fixture));
  const running = runner.run(leased);
  running.catch((error) => t.diagnostic(`Runner failed: ${error.message}`));
  t.after(async () => {
    const current = await app.store.getJob(job.id);
    if (current.status === 'running') await app.store.cancel(job.id, 'admin', 'test-cleanup');
    await running.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await app.conversations.stop(); await app.cards.stop(); await fixtureCards.stop();
    await new Promise((resolve) => app.server.close(resolve));
    await app.store.queue;
    await rm(directory, { recursive: true, force: true });
  });
  t.diagnostic('Awaiting fixture readiness');
  const pids = await ready;
  t.diagnostic('Fixture ready');
  const current = await app.store.getJob(job.id);
  const key = `job:${job.id}:${current.events.find((e) => e.type === 'started').id}`;
  await app.cards.flush(key, true);
  t.diagnostic('Card flushed');
  const card = (await app.store.read()).cardMessages[key];
  const response = await fetch(`${base}/api/v1/events/card-action`, { method: 'POST',
    headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'card.action.trigger', event_id: 'stop-integration', operator_id: 'creator', chat_id: 'group',
      agent_profile: 'owner', message_id: card.messageId, card_content: JSON.stringify(card.card),
      action_value: JSON.stringify({ action: 'cancel', version: jobActionVersion(current) }) }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  t.diagnostic('Cancellation callback accepted');
  await running;
  assert.equal((await app.store.getJob(job.id)).status, 'cancelled');
  for (const pid of [pids.parentPid, pids.childPid]) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('owned card actions work without optional remote card_content; missing ownership still fails closed',async t=>{
 const {context,create,store}=await setup(t);const {job,event}=await create('awaiting_clarification','analysis');
 assert.equal((await handleCardAction(context,event('refresh',{card_content:''}))).ok,true);
 assert.equal((await handleCardAction(context,event('cancel',{card_content:undefined,message_id:'unowned-card'}))).ignored,true);
 assert.equal((await store.getJob(job.id)).status,'awaiting_clarification');
 assert.equal((await handleCardAction(context,event('cancel',{card_content:undefined}))).ok,true);
 const audit=(await store.read()).cardCallbackAudit;assert.equal(audit.at(-1).outcome,'accepted');assert.equal(audit.at(-1).cardContentPresent,false);assert.equal(audit.at(-2).outcome,'ignored');
});

test('expired approval becomes renewal; renewal is idempotent, preserves scope and never approves',async t=>{
 const {writeFile}=await import('node:fs/promises');const {planQuery}=await import('../src/shared/environment-access.js');const {refreshExpiredApprovalCards}=await import('../src/control-plane/approval-expiry.js');
 const {context,create,store,cards,directory}=await setup(t);const old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(directory,'env.json');t.after(()=>{if(old)process.env.AGENTOS_ENVIRONMENTS_FILE=old;else delete process.env.AGENTOS_ENVIRONMENTS_FILE;});
 const config={version:1,environments:{uat:{projectId:'demo',tier:'uat',kind:'nacos',baseUrl:'http://example.test/nacos',credentialRef:'fixture',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{reviewed:true,mode:'investigate',description:'test only',namespaces:['uat'],maxRows:20,timeoutMs:5000,parameters:[{name:'purpose',type:'string'}]}}}}};await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(config));
 const plan=planQuery(config,{environmentId:'uat',queryId:'investigate',parameters:['查看配置']},'demo',{profile:'owner',senderId:'creator'},Date.now()-16*60000);
 const {job,key,event}=await create('awaiting_environment_approval','analysis');await store.transact(s=>{const j=s.jobs.find(x=>x.id===job.id);j.environmentAccess={...plan,approvalRequired:true,approvedBy:null,approvedAt:null};});
 const current=await store.getJob(job.id);const originalMessage=(await store.read()).cardMessages[key].messageId;
 await cards.upsert(key,jobCard(current,Date.parse(plan.expiresAt)-1000),{chatId:'group',replyTo:null,profile:'owner'},{terminal:true,immediate:true});
 await refreshExpiredApprovalCards(context);
 let state=await store.read();assert.match(JSON.stringify(state.cardMessages[key].card),/renew_environment/);assert.doesNotMatch(JSON.stringify(state.cardMessages[key].card),/"action":"approve_environment"/);assert.equal(state.jobs[0].environmentAccess.scopeHash,plan.scopeHash);assert.equal(state.jobs[0].status,'awaiting_environment_approval');
 const renewal=event('renew_environment',{card_content:'',message_id:originalMessage,action_value:JSON.stringify({action:'renew_environment',version:jobActionVersion(current)})});
 assert.equal((await handleCardAction(context,renewal)).ok,true);assert.equal((await handleCardAction(context,renewal)).ok,true);
 const renewed=await store.getJob(job.id);assert.equal(renewed.status,'awaiting_environment_approval');assert.equal(renewed.environmentAccess.approvedBy,null);assert.deepEqual(renewed.environmentAccess.parameters,plan.parameters);assert.notEqual(renewed.environmentAccess.scopeHash,plan.scopeHash);assert.equal(renewed.events.filter(e=>e.type==='environment_renewal_requested').length,1);
 context.projects.ownerOpenIdsByProfile.owner.push('ou_admin');
 const approve=event('approve_environment',{operator_id:'ou_admin',card_content:'',action_value:JSON.stringify({action:'approve_environment',version:jobActionVersion(renewed)})});
 assert.equal((await handleCardAction(context,approve)).ok,true);assert.equal((await handleCardAction(context,approve)).ok,true);assert.equal((await store.getJob(job.id)).status,'queued');assert.equal((await store.getJob(job.id)).events.filter(e=>e.type==='environment_approved').length,1);

 assert.equal((await handleCardAction(context,event('approve_environment',{card_content:'',action_value:JSON.stringify({action:'approve_environment',version:jobActionVersion(current)})}))).ok,false);
});
