import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonStore } from '../src/shared/store.js';
import { PrdWorkspace } from '../src/control-plane/prd-workspace.js';
import { prdMarkdown } from '../src/control-plane/prd-cloud-delivery.js';
import { prdGuidance } from '../src/shared/prd-workspace.js';
import { requiresCausalEvidence } from '../src/shared/investigation-review.js';

const chat = 'oc_team';
const owner = 'ou_owner';
const profile = 'knowledge-ltx';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2l8AAAAASUVORK5CYII=', 'base64');
const md = '# 订单补贴状态\n\n**评审稿**\n\n|系统|影响|\n|---|---|\n|LTX|展示|\n|TPM|状态来源|\n\n## 原型图\n';

async function fixture(t, cli, ltx = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentos-prd-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(path.join(dataDir, 'agentos.json'));
  const cards = { enabled: true, upsert: async () => 'om_card' };
  const projects = { projects: { ltx: { displayName: 'LTX', ...ltx }, tpm: { displayName: 'TPM' } },
    chatProfileProjectMap: { [chat]: { [profile]: 'ltx', 'knowledge-tpm': 'tpm' } } };
  const workspace = new PrdWorkspace({ store, cards, projects, config: { dataDir } },
    { chatIds: [chat], publisher: { profile, ownerOpenId: owner, chatIds: [chat] } }, { cli });
  const group = { chat_type: 'group', chat_id: chat, sender_id: owner, sender_type: 'user', agent_profile: profile };
  const send = (id, content, root, args = {}) => workspace.handle({ ...group, message_id: id, ...(root ? { root_id: root } : {}), ...args.event },
    { agent: { systemAssistant: true }, addressed: args.addressed ?? !root, content });
  return { store, workspace, dataDir, send };
}

test('bare PRD trigger then unmentioned description and decisions keep one question, job and native checkpoint', async t => {
  const { store, workspace, send } = await fixture(t);
  assert.equal(await send('om_regular', '能聊聊 PRD 吗？'), null);
  const { questionId } = await send('om_root', '我要做prd');
  assert.equal((await store.read()).jobs.length, 0);
  assert.equal((await send('om_wrong', '改成仅显示金额', 'om_root', { event: { sender_id: 'ou_other' } })).reason, 'not_prd_requester');
  assert.equal((await send('om_root', '我要做prd', null, { event: { agent_profile: 'knowledge-tpm' } })).reason, 'prd_owned_by_another_assistant');
  await send('om_detail', '在 LTX 订单详情展示 TPM 补贴状态', 'om_root');
  const first = (await store.read()).jobs[0];
  assert.equal(first.questionId, questionId);
  assert.equal(first.workflow, 'continuous_analysis');
  assert.match(prdGuidance(first), /双方影响/);
  await send('om_decision', '只做 PC，隐藏金额', 'om_root');
  await store.transact(s => {
    const j = s.jobs[0];
    j.status = 'completed';
    j.result = { outcome: 'ready', finalMessage: '草稿' };
    j.analysisContinuation = { questionId, workspace: '/fixed/workspace', threadId: 'native-thread', executionEngine: 'native-tools-v1' };
  });
  await workspace.resumePending(questionId);
  const state = await store.read();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, first.id);
  assert.equal(state.jobs[0].analysisContinuation.threadId, 'native-thread');
  assert.equal(state.jobs[0].currentQuestion, '只做 PC，隐藏金额');
  assert.equal((await send('om_decision', '只做 PC，隐藏金额', 'om_root')).duplicate, true);
  assert.equal(await send('om_another', '另一条普通消息', 'om_unrelated'), null);
});

test('PRD as a document name does not collide with a later SIT environment clarification', async t => {
  const { store, send } = await fixture(t, undefined, { analysisSourceMode: 'isolated',
    analysisEnvironments: { sit: {}, prd: {} } });
  const { questionId } = await send('om_prd', '我要做prd');
  await send('om_request', '【补贴状态 PRD】输出订单详情的需求设计', 'om_prd');
  assert.equal((await store.read()).jobs.length, 0);
  await send('om_environment', '明确使用 SIT 环境核对 LTX 和 TPM 源码', 'om_prd');
  const [job] = (await store.read()).jobs;
  assert.equal(job.questionId, questionId);
  assert.equal(job.sourceEnvironment, 'sit');
  assert.match(job.originalQuestion, /补贴状态 PRD/);
});

test('a PRD display rule about rejection reasons is not a request to investigate a live incident', () => {
  const prd = { revision: 1 };
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '增加状态字段，不展示驳回原因' }), false);
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '核实这笔补贴被驳回的原因' }), true);
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function saveArtifact(dataDir, job, id, format, bytes) {
  const dir = path.join(dataDir, 'exports', job.id), item = { id, filename: id + '.' + format, format, kind: 'document',
    sha256: hash(bytes), bytes: bytes.length, rowCount: 0, complete: true, questionGeneration: 2 };
  await fs.mkdir(dir, { recursive: true });
  const receipt = Buffer.from(JSON.stringify({ version: 2, kind: 'document', status: 'verified',
    binding: { jobId: job.id }, file: item, coverage: { rowCount: 0 } }));
  await fs.writeFile(path.join(dir, item.filename), bytes);
  await fs.writeFile(path.join(dir, id + '.verification.json'), receipt);
  return { ...item, verificationHash: hash(receipt) };
}

test('cross-system PRD delivers styled cloud review draft as the owner with native table/image and scoped editable ACL', async t => {
  const calls = [];
  let image = false;
  const doc = 'AbcDocumentToken';
  const cli = async (args, opts) => {
    calls.push([args, opts]);
    assert.equal(opts.profile, profile);
    assert.ok(args.includes('user'));
    if (args[0] === 'api') return { data: { open_id: owner } };
    if (args[1] === '+create') { assert.equal(opts.input, md.trim()); return { data: { document_id: doc, url: 'https://unit.feishu.cn/docx/' + doc } }; }
    if (args[1] === '+fetch') return { data: { content: '<h1>订单补贴状态</h1><table/><table><tr><td>TPM</td></tr></table>' + (image ? '<img href="owned.png"/>' : '') } };
    if (args[1] === '+media-insert') { image = true; assert.deepEqual(await fs.readFile(path.join(opts.cwd, 'prototype.png')), png); return {}; }
    if (args[1] === '+member-add') { assert.ok(args.includes(chat)); assert.ok(args.includes('openchat')); assert.ok(args.includes('edit')); return {}; }
    if (args[1] === '+member-list') return { data: { items: [{ member_id: chat, member_type: 'openchat', perm: 'edit' }] } };
    throw Error('unexpected CLI');
  };
  const { store, workspace, send, dataDir } = await fixture(t, cli);
  const { questionId } = await send('om_start', '我要写 PRD：LTX 订单详情增加 TPM 补贴状态');
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = { outcome: 'ready' }; });
  await send('om_export', '导出飞书文档', 'om_start');
  const exportJob = (await store.read()).jobs[0];
  assert.match(prdGuidance(exportJob), /提交一个 md 和一个 png/);
  const files = await Promise.all([
    saveArtifact(dataDir, exportJob, 'report-11111111-1111-1111-1111-111111111111', 'md', Buffer.from(md)),
    saveArtifact(dataDir, exportJob, 'report-22222222-2222-2222-2222-222222222222', 'png', png),
  ]);
  await store.transact(s => {
    const j = s.jobs[0];
    j.status = 'completed';
    j.result = { outcome: 'ready' };
    j.reportFiles = files;
    j.reportReviews = Object.fromEntries(files.map(f => [f.id, { status: 'accepted', verificationHash: f.verificationHash }]));
  });
  await workspace.publisher.deliver(questionId);
  await workspace.publisher.deliver(questionId);
  const d = (await store.read()).questions[questionId].prd.delivery;
  assert.equal(d.phase, 'delivered', d.notice);
  assert.ok(d.sentAt);
  assert.equal(calls.filter(([a]) => a[1] === '+create').length, 1);
  assert.equal(calls.filter(([a]) => a[1] === '+member-add').length, 1);
  assert.throws(() => prdMarkdown(md + '![remote](https://example.com/pixel.png)'));
});

test('missing owner authorization never creates a document or expands sharing', async t => {
  const { workspace, store, send, dataDir } = await fixture(t, async args => {
    assert.equal(args[0], 'api');
    return { data: { open_id: 'ou_wrong_account' } };
  });
  const { questionId } = await send('om_start', '我要做PRD：新增状态');
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = { outcome: 'ready' }; });
  await send('om_export', '生成飞书文档', 'om_start');
  const j = (await store.read()).jobs[0];
  const files = await Promise.all([
    saveArtifact(dataDir, j, 'report-33333333-3333-3333-3333-333333333333', 'md', Buffer.from(md)),
    saveArtifact(dataDir, j, 'report-44444444-4444-4444-4444-444444444444', 'png', png),
  ]);
  await store.transact(s => { Object.assign(s.jobs[0], { status: 'completed', result: { outcome: 'ready' }, reportFiles: files }); });
  await workspace.publisher.deliver(questionId);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase, 'authorization_required');
});
