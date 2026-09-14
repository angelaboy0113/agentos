import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canContinueTask, canCreateTask, isTaskCreator, isAdministrator, validateHumanIdentities } from '../src/control-plane/authorization.js';
import { loadProjects, saveProjects } from '../src/control-plane/config.js';
import { JsonStore } from '../src/shared/store.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { jobCard, jobActionVersion } from '../src/control-plane/message-cards.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { detailVersion, resultPages } from '../src/control-plane/result-presentation.js';

const projects = { humanIdentities: { alice: { owner: 'alice-owner', dev: 'alice-dev', qa: 'alice-qa' } },
  ownerOpenIdsByProfile: { owner: ['boss-owner'], dev: ['boss-dev'] } };

test('verified cross-profile creator mapping is not an administrator grant; ambiguous identities fail closed', () => {
  const job = { senderId: 'alice-owner', originProfile: 'owner' };
  assert.equal(isTaskCreator(projects, job, { profile: 'dev', senderId: 'alice-dev' }), true);
  assert.equal(isTaskCreator(projects, job, { profile: 'qa', senderId: 'alice-qa' }), true);
  assert.equal(isTaskCreator(projects, job, { profile: 'dev', senderId: 'alice-owner' }), false);
  assert.equal(isTaskCreator(projects, job, { profile: 'dev', senderId: 'stranger' }), false);
  assert.equal(isTaskCreator({}, job, { profile: 'dev', senderId: 'alice-dev' }), false);
  assert.equal(isTaskCreator({}, {}, {}), false);
  assert.equal(isAdministrator(projects, { profile: 'dev', senderId: 'alice-dev' }), false);
  assert.equal(canCreateTask(projects, { profile: 'dev', senderId: 'alice-dev' }, 'analysis'), true);
  for (const intent of ['implementation', 'planning', 'verification', 'audit']) {
    assert.equal(canCreateTask(projects, { profile: 'dev', senderId: 'alice-dev' }, intent), false);
  }
  assert.equal(canContinueTask(projects, { taskIntent: 'analysis' }, { profile: 'dev', senderId: 'alice-dev' }), true);
  assert.equal(canContinueTask(projects, { taskIntent: 'implementation' }, { profile: 'dev', senderId: 'alice-dev' }), false);
  assert.equal(canCreateTask(projects, { profile: 'dev', senderId: 'boss-dev' }, 'implementation'), true);
  const ambiguous = { ...projects, humanIdentities: { ...projects.humanIdentities, other: { owner: 'alice-owner', dev: 'stranger' } } };
  assert.throws(() => validateHumanIdentities(ambiguous.humanIdentities), /Ambiguous/);
  assert.equal(isTaskCreator(ambiguous, job, { profile: 'dev', senderId: 'stranger' }), false);
});

test('project load/save preserves trusted identity mappings and rejects malformed configuration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aos-identity-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'projects.json');
  await saveProjects(file, { ...projects, projects: {}, chatProjectMap: { group: 'demo' } });
  const loaded = await loadProjects(file);
  await saveProjects(file, { ...loaded, chatProjectMap: { group: 'new' } });
  assert.deepEqual((await loadProjects(file)).humanIdentities, projects.humanIdentities);
  await writeFile(file, JSON.stringify({ humanIdentities: { bad: { dev: null } } }));
  await assert.rejects(loadProjects(file), /Invalid/);
});

test('delegated creator can refresh, page and cancel own task but cannot approve or operate another group/person', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aos-linked-card-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let sends = 0;
  const feishu = { sendCard: async () => ({ message_id: `om_${++sends}` }), updateCard: async () => {}, reply: async () => {} };
  const cards = new LiveCards(store, feishu, { intervalMs: 0 });
  t.after(async () => { await cards.stop(); await rm(dir, { recursive: true, force: true }); });
  const context = { store, cards, feishu, projects, agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' }, qa: { profile: 'qa' } } } };
  const { job } = await store.createJob({ stage: 'developer', agentProfile: 'dev', originProfile: 'owner', senderId: 'alice-owner',
    chatId: 'group', projectId: 'demo', projectName: 'demo', workflow: 'full_delivery', instruction: 'test', status: 'awaiting_approval' });
  const text = '证据详细说明。\n'.repeat(500);
  await store.transact((s) => { s.jobs[0].result = { summary: '测试结论', finalMessage: text }; });
  const current = await store.getJob(job.id);
  const key = `job:${job.id}:first`;
  const id = await cards.upsert(key, jobCard(current), { chatId: 'group', profile: 'dev' }, { terminal: true, immediate: true, resultText: text });
  let sequence = 0;
  const event = (action, extra = {}) => ({ type: 'card.action.trigger', event_id: `e-${++sequence}`, operator_id: 'alice-dev', agent_profile: 'dev',
    chat_id: 'group', message_id: id, card_content: JSON.stringify(jobCard(current)), action_value: { action, version: jobActionVersion(current) }, ...extra });
  const before = JSON.stringify((await store.read()).jobs);
  const refresh = event('refresh');
  assert.equal((await handleCardAction(context, refresh)).ok, true);
  assert.equal((await handleCardAction(context, refresh)).ok, true);
  assert.equal(JSON.stringify((await store.read()).jobs), before);
  const paging = event('result_page', { action_value: { action: 'result_page', page: 1, version: detailVersion(resultPages(text)) } });
  assert.equal((await handleCardAction(context, paging)).ok, true);
  assert.equal(JSON.stringify((await store.read()).jobs), before);
  assert.equal((await handleCardAction(context, event('approve'))).ok, false);
  for (const extra of [{ operator_id: 'stranger' }, { chat_id: 'other' }, { agent_profile: 'owner' }, { operator_id: 'alice-owner' }]) {
    assert.notEqual((await handleCardAction(context, event('cancel', extra))).ok, true);
  }
  assert.equal((await handleCardAction(context, event('refresh', { action_value: '{broken' }))).ignored, true);
  assert.equal(JSON.stringify((await store.read()).jobs), before);
  assert.equal((await handleCardAction(context, event('cancel'))).ok, true);
  assert.equal((await store.getJob(job.id)).status, 'cancelled');
  assert.equal((await store.read()).jobs.length, 1);
});
