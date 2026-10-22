import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveProjectId, routeAgent, validateProjectScopes } from '../src/shared/project-scope.js';
import { createControlPlane, handleLarkCliEvent } from '../src/control-plane/server.js';
import { larkEventSourcePlans } from '../src/control-plane/lark-event-source.js';
import { requestEnrollment } from '../src/control-plane/environment-enrollment.js';
import { sourceEnvironmentCatalog } from '../src/shared/source-environments.js';
import { buildPrompt } from '../src/runner/codex-executor.js';

const agents = {
  a: { profile: 'a', openId: 'bot-a', displayName: 'A 助手', role: 'developer', projectId: 'alpha', systemAssistant: true, allowedChatIds: ['shared'] },
  b: { profile: 'b', openId: 'bot-b', displayName: 'B 助手', role: 'developer', projectId: 'beta', systemAssistant: true, allowedChatIds: ['shared'] },
};
const projects = {
  chatProjectMap: { legacy: 'alpha', shared: 'alpha' },
  chatProfileProjectMap: { shared: { a: 'alpha', b: 'beta' } },
  projects: { alpha: { displayName: 'ALPHA', analysisSourceMode: 'isolated', analysisEnvironments: { uat: {}, prd: {} } }, beta: { displayName: 'BETA', analysisSourceMode: 'isolated', analysisEnvironments: { sit: {}, prd: {} } } },
  ownerOpenIdsByProfile: { a: ['admin-a'], b: ['admin-b'] },
};
test('profile binding is authoritative, unknown profile cannot fall back, legacy groups stay compatible', () => {
  assert.equal(resolveProjectId(projects, 'shared', 'a'), 'alpha');
  assert.equal(resolveProjectId(projects, 'shared', 'b'), 'beta');
  assert.equal(resolveProjectId(projects, 'shared', 'unknown'), null);
  assert.equal(resolveProjectId(projects, 'shared', 'constructor'), null);
  assert.equal(resolveProjectId(projects, 'constructor', 'a'), null);
  assert.equal(resolveProjectId(projects, 'legacy', 'b'), 'alpha');
  assert.throws(() => validateProjectScopes({ chatProfileProjectMap: { shared: { a: 'missing' } }, projects: {} }));
});
test('every execution stage retains its original system bot; old role routing still works', () => {
  for (const role of ['developer', 'qa', 'owner_report']) {
    assert.equal(routeAgent(agents, role, 'a').agentProfile, 'a');
    assert.equal(routeAgent(agents, role, 'b').agentProfile, 'b');
  }
  assert.equal(routeAgent({ developer: { profile: 'legacy-dev' } }, 'developer').agentProfile, 'legacy-dev');
  const plans = larkEventSourcePlans({}, agents);
  assert.equal(plans.length, 4);
  assert.ok(plans.every(p => p.role === 'developer' && p.allowedChatIds[0] === 'shared' && p.groupOnly === true));
});

async function fixture(t, decide) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-systems-'));
  const input = [], replies = [];
  const scoped = structuredClone(projects);
  const md = path.join(dir, 'assistant.md');
  await writeFile(md, 'ONLY_ALPHA_RULE');
  scoped.projects.alpha.assistantInstructionsFile = md;
  const app = await createControlPlane({
    dataDir: dir, storeFile: path.join(dir, 'state.json'), projectsFile: path.join(dir, 'projects.json'),
    conversationFile: path.join(dir, 'conversation.json'), contactsFile: path.join(dir, 'contacts.json'),
    knowledgeFile: path.join(dir, 'knowledge.json'), memoryFile: path.join(dir, 'memory.json'),
    projects: scoped, agents: { agents },
    feishuClient: { reply: async (id, text, options) => { replies.push({ id, text, options }); return { data: { message_id: `reply-${replies.length}` } }; } },
    conversationResponder: async value => { input.push(value); return { reply: '回答', action: 'reply', intent: 'none', instruction: '', jobId: '', projectId: '', attachmentIds: [], ...decide(value) }; },
  });
  t.after(async () => { await app.conversations.stop(); await rm(dir, { recursive: true, force: true }); });
  const event = (profile, id, fields = {}) => ({ type: 'im.message.receive_v1', message_id: id, chat_id: 'shared', chat_type: 'group', sender_type: 'user', sender_id: `member-${profile}`, agent_role: 'developer', agent_profile: profile, mentions: [{ id: `bot-${profile}` }], content: `问题 ${id}`, ...fields });
  const send = async value => { const r = await handleLarkCliEvent(app, value); await app.conversations.idle(); return r; };
  return { app, input, replies, event, send };
}
test('same group keeps system rules, history, source environment, and execution identity separate', async t => {
  const { app, input, send, event } = await fixture(t, value => ({ action: 'create_task', intent: 'analysis', instruction: '只读调查本系统', sourceEnvironment: value.project.id === 'alpha' ? 'uat' : 'sit' }));
  await send(event('a', 'a-one')); await send(event('b', 'b-one'));
  assert.equal(input[0].project.id, 'alpha'); assert.equal(input[1].project.id, 'beta');
  assert.match(input[0].assistantScope.instructions, /ONLY_ALPHA_RULE/);
  assert.equal(input[1].assistantScope, undefined); assert.equal(input[1].history.length, 0);
  const jobs = (await app.store.read()).jobs;
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => [j.projectId, j.agentProfile, j.sourceEnvironment]), [['alpha', 'a', 'uat'], ['beta', 'b', 'sit']]);
});
test('wrong group and forged role are rejected before conversation or credentials', async t => {
  const { app, input, send, event } = await fixture(t, () => ({}));
  assert.equal((await send(event('a', 'outside', { chat_id: 'old-group' }))).reason, 'outside_assistant_group');
  assert.equal((await send(event('a', 'private', { chat_type: 'p2p', chat_id: 'private' }))).reason, 'assistant_group_only');
  await assert.rejects(send(event('a', 'forged', { agent_role: 'owner_intake' })), /mismatch/);
  assert.equal(input.length, 0); assert.equal((await app.store.read()).jobs.length, 0);
});
test('member write, model-directed cross-system task, and missing environment cannot create jobs', async t => {
  const { app, send, event } = await fixture(t, value => value.message.includes('write') ? { action: 'create_task', intent: 'implementation', instruction: '修改代码' }
    : value.message.includes('cross') ? { action: 'create_task', intent: 'analysis', projectId: 'beta', instruction: '调查其它系统', sourceEnvironment: 'prd' }
    : { action: 'create_task', intent: 'analysis', instruction: '调查本系统' });
  await send(event('a', 'write')); await send(event('a', 'cross')); await send(event('a', 'no-env'));
  assert.equal((await app.store.read()).jobs.length, 0);
});
test('environment enrollment uses the requesting system, never the legacy group fallback', async () => {
  const turn = { id: 't', questionId: 'q', chatId: 'shared', profile: 'b', senderId: 'member-b', decision: { instruction: '接入测试 Nacos', environmentSetup: { kind: 'nacos', tier: 'uat', url: 'http://nacos.example/nacos' } } };
  const state = { jobs: [], conversations: [turn], questions: { q: { id: 'q', generation: 1 } } };
  const context = { config: { dataDir: '/unused' }, projects, store: { read: async () => structuredClone(state), transact: async fn => fn(state) } };
  await requestEnrollment(context, turn);
  assert.equal(Object.values(state.environmentEnrollments)[0].projectId, 'beta');
});
test('missing environment branches are visible evidence gaps and cannot be silently covered by another branch', async () => {
  const gap = { path: 'shared-library', branch: 'sit', reason: '远端分支不存在' };
  const project = { analysisSourceMode: 'isolated', analysisEnvironments: { sit: { description: '测试', repositories: [], unavailableRepositories: [gap] } } };
  assert.deepEqual(sourceEnvironmentCatalog(project)[0].unavailableRepositories, [gap]);
  const prompt = await buildPrompt({ id: 'test', stage: 'developer', taskIntent: 'analysis', projectId: 'beta', sourceEnvironment: 'sit', instruction: '调查测试系统' }, project, { instruction: 'role', metadata: {} });
  assert.match(prompt, /shared-library/);
  assert.match(prompt, /不改读其它环境/);
});
