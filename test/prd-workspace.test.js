import { PrdCloudDelivery } from '../src/control-plane/prd-cloud-delivery.js';
import { prdPrototypeRevision } from '../src/runner/document-handoff.js';
import { runInNewContext } from 'node:vm';
import { chromeDesignStyle } from '../src/control-plane/shared-chrome-browser.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { questionView } from '../src/control-plane/questions.js';
import { savePrdDesignReference } from '../src/control-plane/website-evidence.js';
import { nativeImageReferences } from '../src/shared/image-generation.js';
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

async function fixture(t, cli, ltx = {}, feishu) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentos-prd-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(path.join(dataDir, 'agentos.json'));
  const cards = { enabled: true, upsert: async () => 'om_card' };
  const projects = { projects: { ltx: { displayName: 'LTX', ...ltx }, tpm: { displayName: 'TPM' } },
    chatProfileProjectMap: { [chat]: { [profile]: 'ltx', 'knowledge-tpm': 'tpm' } } };
  const workspace = new PrdWorkspace({ store, cards, projects, feishu, config: { dataDir } },
    { chatIds: [chat], publisher: { profile, ownerOpenId: owner, chatIds: [chat] } }, { cli });
  const group = { chat_type: 'group', chat_id: chat, sender_id: owner, sender_type: 'user', agent_profile: profile };
  const send = (id, content, root, args = {}) => workspace.handle({ ...group, message_id: id, ...(root ? { root_id: root } : {}), ...args.event },
    { agent: { systemAssistant: true }, addressed: args.addressed ?? !root, content, form: args.form });
  return { store, workspace, dataDir, send, cards, projects };
}

test('ordinary requirement language starts a PRD card while lookup and negated requests do not', async t => {
  const { store, send } = await fixture(t);
  for (const [i, text] of ['我想要做一个prd', '我想要做一个需求', '我需要写一份需求文档', '帮我起草个PRD'].entries()) {
    assert.ok((await send('om_natural'+i, text)).questionId, text);
  }
  for (const [i, text] of ['我想查一个需求', '我不想做一个需求', '我想做一个需求查询', '解释一下 PRD'].entries()) {
    assert.equal(await send('om_regular'+i, text), null, text);
  }
  const state = await store.read();
  assert.equal(state.jobs.length, 0);
  assert.equal(Object.values(state.questions).length, 4);
});

function draftFeishu(calls, { shared = true, environment = '参考环境：SIT' } = {}) {
  const text = content => ({ elements: [{ text_run: { content } }] });
  return {
    async cloudDocumentMembers(token, options) {
      calls.push(['acl', token, options.profile]);
      return { items: [{ member_type: 'openchat', member_id: shared ? chat : 'oc_elsewhere', perm: 'view' }] };
    },
    async cloudDocumentImage(token, options) {
      calls.push(['image', token, options.profile]);
      return png;
    },
    async cloudRequest(route, params, options) {
      calls.push([route, params.token, options.profile]);
      if (route.includes('/get_node')) return { node: { obj_type: 'docx', obj_token: 'DraftToken', title: '补贴状态' } };
      return { items: [
        { block_id: 'root', block_type: 1, page: text('补贴状态') },
        { block_id: '1', text: text(environment) },
        { block_id: '2', text: text('LTX订单显示TPM补贴状态') },
        { block_id: '3', block_type: 27, image: { token: 'DraftImage' } },
        { block_id: '4', table: { cells: ['5','6'], property: { column_size: 2 } } },
        { block_id: '5', children: ['7'] }, { block_id: '6', children: ['8'] },
        { block_id: '7', text: text('TPM') }, { block_id: '8', text: text('状态来源') },
      ] };
    },
  };
}

test('natural PRD request plus a wiki link alone reads the shared draft first and uses its explicit source environment', async t => {
  const calls = [];
  const { store, send } = await fixture(t, undefined, { analysisSourceMode: 'isolated',
    analysisEnvironments: { sit: {}, prd: {} } }, draftFeishu(calls));
  const prompt = '我需要做一个prd，https://unit.feishu.cn/wiki/WikiToken?from=im。';
  const { questionId } = await send('om_prdlink', prompt);
  const state = await store.read();
  assert.equal(state.questions[questionId].title, '补贴状态');
  const [job] = state.jobs;
  assert.equal(job.questionId, questionId);
  assert.equal(job.sourceEnvironment, 'sit');
  assert.match(job.originalQuestion, /LTX订单显示TPM补贴状态/);
  assert.match(job.originalQuestion, /TPM \| 状态来源/);
  assert.match(job.originalQuestion, /1 个图片块/);
  assert.equal(job.attachments.length, 1);
  assert.match(job.originalQuestion, new RegExp(job.attachments[0].id));
  assert.equal(job.attachments[0].type, 'image');
  assert.equal(job.attachments[0].source.sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(await fs.readFile(job.attachments[0].path), png);
  assert.equal((await send('om_prdlink', prompt)).duplicate, true);
  assert.deepEqual(calls, [
    ['/open-apis/wiki/v2/spaces/get_node', 'WikiToken', profile],
    ['acl', 'DraftToken', profile],
    ['/open-apis/docx/v1/documents/DraftToken/blocks', undefined, profile],
    ['image', 'DraftImage', profile],
  ]);
});

test('a follow-up draft link and environment answer in the card reuse the original PRD question', async t => {
  const calls = [];
  const { store, send } = await fixture(t, undefined, { analysisSourceMode: 'isolated',
    analysisEnvironments: { sit: {}, prd: {} } }, draftFeishu(calls, { environment: '' }));
  const { questionId } = await send('om_prdroot', '我想做个需求');
  await send('om_link', 'https://unit.feishu.cn/docx/DraftToken', 'om_prdroot');
  const first = await store.read();
  const view = questionView(first, questionId);
  assert.equal(first.jobs.length, 0);
  assert.match(JSON.stringify(view.card), /飞书初稿已读并保留/);
  const { version } = first.questions[questionId].prd.intake;
  await store.transact(s => { s.cardMessages = { ['question:'+questionId]: { messageId: 'om_card' } }; });
  await send('om_form', '生产环境', 'om_prdroot', { form: { questionId, cardId: 'om_card', version } });
  const current = await store.read();
  assert.equal(current.jobs.length, 1);
  assert.equal(current.jobs[0].sourceEnvironment, 'prd');
  assert.match(current.jobs[0].originalQuestion, /LTX订单显示TPM补贴状态/);
  assert.equal(calls.length, 3);
});

test('an outside-group draft never reads the body and can be replaced with text in the same PRD card', async t => {
  const calls = [];
  const { store, send } = await fixture(t, undefined, {}, draftFeishu(calls, { shared: false }));
  const { questionId } = await send('om_private', '我想做一个需求 https://unit.feishu.cn/docx/DraftToken');
  const first = await store.read();
  assert.equal(first.jobs.length, 0);
  assert.match(first.questions[questionId].prd.intake.prompt, /共享给本群/);
  assert.equal(calls.length, 1);
  await send('om_text', '订单详情加补贴状态', 'om_private');
  const [job] = (await store.read()).jobs;
  assert.equal(job.questionId, questionId);
  assert.equal(job.originalQuestion, '订单详情加补贴状态');
});

test('a saved link read resumes on startup without a second PRD job', async t => {
  const calls = [];
  const { store, workspace, send } = await fixture(t, undefined, {}, draftFeishu(calls));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  workspace.readDraft = async () => { entered.resolve(); return release.promise; };
  const original = send('om_interrupted', '我想做一个需求 https://unit.feishu.cn/docx/DraftToken');
  await entered.promise;
  const saved = await store.read();
  assert.equal(saved.conversations[0].prdDraftReading, true);
  assert.match(JSON.stringify(questionView(saved, saved.conversations[0].questionId).card), /正在读取飞书初稿/);
  const restarted = new PrdWorkspace(workspace.context, { chatIds: [chat] });
  await restarted.resumeDraftImports();
  release.resolve({ title: '不应重复使用', text: '第一轮迟到的结果' });
  await original;
  const done = await store.read();
  assert.equal(done.conversations[0].prdDraftReading, undefined);
  assert.equal(done.jobs.length, 1);
  assert.match(done.jobs[0].originalQuestion, /LTX订单显示TPM补贴状态/);
  assert.equal(calls.length, 3);
});

test('a denied or non-image preview leaves the document text and table available', async t => {
  const calls = [];
  const client = draftFeishu(calls);
  client.cloudDocumentImage = async () => Buffer.from('{"error":"permission denied"}');
  const { store, send } = await fixture(t, undefined, {}, client);
  await send('om_preview_denied', '我想做一个需求 https://unit.feishu.cn/docx/DraftToken');
  const [job] = (await store.read()).jobs;
  assert.equal(job.attachments.length, 0);
  assert.match(job.originalQuestion, /预览不可用/);
  assert.match(job.originalQuestion, /TPM \| 状态来源/);
});

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

test('a single PRD form stays open through execution and partial results, then closes on verified delivery', async t => {
  const { cards, store, workspace, send } = await fixture(t);
  const { questionId } = await send('om_live_form', '我想做一个需求，订单详情增加补贴状态');
  await store.transact(s => {
    const job = s.jobs[0];
    job.status = 'running';
    job.analysisContinuation = { questionId, threadId: 'prd-fixed-thread', workspace: '/fixed/workspace' };
    s.cardMessages = { ['question:'+questionId]: { messageId: 'om_card' } };
  });
  const render = async () => questionView(await store.read(), questionId);
  const formIn = view => view.card.body.elements.filter(e => e.tag === 'form');
  const refreshed = [];
  cards.upsert = async (key, card) => { refreshed.push(key); return 'om_card'; };
  await workspace.refreshOpenForms();
  assert.deepEqual(refreshed, ['question:'+questionId]);
  const active = await render();
  assert.equal(active.card.header.template, 'blue');
  assert.equal(active.mention, null);
  assert.equal(formIn(active).length, 1);
  const version = formIn(active)[0].elements[1].name.slice(4);
  const args = { form: { questionId, cardId: 'om_card', version } };
  const submitted = await send('prd-form:active', '只做 PC 端', 'om_live_form', args);
  assert.equal(submitted.pending, true);
  const pending = await render();
  assert.match(JSON.stringify(pending.card), /已收到补充，当前轮结束后/);
  assert.equal(formIn(pending)[0].elements[1].name.slice(4), version);
  assert.equal((await send('prd-form:active', '只做 PC 端', 'om_live_form', args)).duplicate, true);
  await store.transact(s => {
    s.jobs[0].status = 'completed';
    s.jobs[0].result = { outcome: 'partial', finalMessage: '待定稿' };
  });
  const partial = await render();
  assert.equal(formIn(partial).length, 1);
  await workspace.resumePending(questionId);
  const updated = (await store.read()).jobs[0];
  assert.equal(updated.analysisContinuation.threadId, 'prd-fixed-thread');
  assert.equal(updated.prd.revision, 2);
  assert.equal(updated.currentQuestion, '只做 PC 端');
  assert.equal((await send('prd-form:stale', '错误补充', 'om_live_form', args)).reason, 'prd_form_stale');
  await store.transact(s => {
    const job = s.jobs[0];
    job.status = 'completed';
    job.result = { outcome: 'ready', finalMessage: '已完成' };
    s.questions[questionId].prd.delivery = { revision: 2, phase: 'delivered', sentAt: new Date().toISOString(),
      url: 'https://unit.feishu.cn/docx/FinalDoc' };
  });
  const delivered = await render();
  assert.equal(formIn(delivered).length, 0);
  assert.match(JSON.stringify(delivered.card), /https:\/\/unit\.feishu\.cn\/docx\/FinalDoc/);
});

test('a PRD display rule about rejection reasons is not a request to investigate a live incident', () => {
  const prd = { revision: 1 };
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '增加状态字段，不展示驳回原因' }), false);
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '核实这笔补贴被驳回的原因' }), true);
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function saveArtifact(dataDir, job, id, format, bytes) {
  const dir = path.join(dataDir, 'exports', job.id), item = { id, filename: id + '.' + format, format, kind: 'document',
    sha256: hash(bytes), bytes: bytes.length, rowCount: 0, complete: true, questionGeneration: job.prd.revision };
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
    if (args[0] === 'auth') {
      assert.match(args[3], /docs:permission.member:create/);
      return { ok: true, missing: [] };
    }
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
  const j = (await store.read()).jobs[0];
  const files = await Promise.all([
    saveArtifact(dataDir, j, 'report-33333333-3333-3333-3333-333333333333', 'md', Buffer.from(md)),
    saveArtifact(dataDir, j, 'report-44444444-4444-4444-4444-444444444444', 'png', png),
  ]);
  await store.transact(s => { Object.assign(s.jobs[0], { status: 'completed', result: { outcome: 'ready' }, reportFiles: files }); });
  await workspace.publisher.deliver(questionId);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase, 'authorization_required');
});

test('an ungranted document scope leaves a retryable draft before any create request', async t => {
  const calls = [];
  const { workspace, store, send, dataDir } = await fixture(t, async args => {
    calls.push(args[0]);
    if (args[0] === 'api') return { data: { open_id: owner } };
    if (args[0] === 'auth') throw Error('lark-cli exited 1: {"ok":false,"missing":["docx:document"]}');
    assert.fail('Document creation must wait for user consent');
  });
  const { questionId } = await send('om_start', '我要做PRD：新增状态');
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = { outcome: 'ready' }; });
  const [job] = (await store.read()).jobs;
  const files = await Promise.all([
    saveArtifact(dataDir, job, 'report-55555555-5555-5555-5555-555555555555', 'md', Buffer.from(md)),
    saveArtifact(dataDir, job, 'report-66666666-6666-6666-6666-666666666666', 'png', png),
  ]);
  await store.transact(s => { Object.assign(s.jobs[0], { status: 'completed', result: { outcome: 'ready' }, reportFiles: files }); });
  await workspace.publisher.deliver(questionId);
  assert.deepEqual(calls, ['api', 'auth']);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase, 'authorization_required');
});


test('the requester submits the revision-bound PRD card and processing resumes without an export command', async t => {
  const { store, workspace, cards, projects, send } = await fixture(t);
  const context = {store,cards,projects,prd:workspace,agents:{agents:{developer:{profile}}}};
  const {questionId} = await send('om_card_root','我要做 PRD');
  const cardId = 'om_prd_card';
  async function saveCard() {
    const view = questionView(await store.read(),questionId,projects);
    const form = view.card.body.elements.find(e => e.name === 'prd_answers');
    assert.ok(form);
    assert.doesNotMatch(JSON.stringify(view.card), /补充或追问请在话题中@对应助手/);
    assert.match(view.mention.text, /提交补充/);
    await store.transact(state => {
      state.cardMessages ??= {};
      state.cardMessages['question:'+questionId] = {messageId:cardId,destination:view.destination,card:view.card};
    });
    return form.elements[1].name;
  }
  const makeEvent = (name,id,answer,operator=owner) => ({type:'card.action.trigger',event_id:id,
    operator_id:operator,agent_profile:profile,message_id:cardId,chat_id:chat,action_name:name,form_value:{clarification:answer}});
  const initial = await saveCard();
  assert.equal((await handleCardAction(context,makeEvent(initial,'other','加状态','ou_other'))).reason,'not_prd_requester');
  assert.ok((await handleCardAction(context,makeEvent(initial,'first','订单详情增加补贴状态'))).ok);
  const [first] = (await store.read()).jobs;
  assert.equal(first.prd.exportRevision,1);
  await store.transact(state => {
    const j=state.jobs[0];
    j.status='awaiting_clarification';
    j.result={outcome:'needs_clarification',investigation:{blocker:{kind:'user_input',needed:'需要显示补贴金额吗？'}}};
    j.analysisContinuation={questionId,threadId:'same-native-thread',workspace:'/fixed'};
  });
  const follow = await saveCard();
  assert.equal((await handleCardAction(context,makeEvent(initial,'stale','错误补充'))).ok,false);
  const event = makeEvent(follow,'next','不展示金额。');
  assert.ok((await handleCardAction(context,event)).ok);
  assert.equal((await handleCardAction(context,event)).duplicate,true);
  const [job] = (await store.read()).jobs;
  assert.equal(job.id,first.id);
  assert.equal(job.analysisContinuation.threadId,'same-native-thread');
  assert.deepEqual(job.prd,{revision:2,exportRevision:2,auto:true});
  assert.equal(job.currentQuestion,'不展示金额。');
});

test('website design references are hash-bound to the real page capture, job, environment and revision', async t => {
  const {dataDir} = await fixture(t);
  const job={id:'JOB-design',questionId:'QST-design',sourceEnvironment:'sit',prd:{auto:true,revision:2}};
  const dir=path.join(dataDir,'website-evidence',job.id);
  await fs.mkdir(dir,{recursive:true});
  const item={name:'a-0.png',sha256:hash(png),bytes:png.length};
  await fs.writeFile(path.join(dir,item.name),png);
  await savePrdDesignReference(dataDir,job,item);
  assert.deepEqual(await nativeImageReferences(dataDir,job),[{path:path.join(dir,item.name),sha256:item.sha256,kind:'website-design-reference'}]);
  assert.deepEqual(await nativeImageReferences(dataDir,{...job,prd:{...job.prd,revision:3}}),[]);
  await assert.rejects(nativeImageReferences(dataDir,{...job,sourceEnvironment:'prd'}),{code:'IMAGE_INPUT'});
});


test('shared Chrome extracts actual colors and geometry without page text or form values', () => {
  const node={innerText:'业务敏感值',value:'token123',getBoundingClientRect:()=>({x:10,y:20,width:100,height:36,right:110,bottom:56})};
  const body={};
  const actual=runInNewContext(`(${chromeDesignStyle.toString()})('https://test.example/')`,{
    URL,location:{origin:'https://test.example'},innerWidth:1000,innerHeight:720,
    document:{readyState:'complete',body,querySelectorAll:selector=>selector.startsWith('button')?[node]:[]},
    getComputedStyle:el=>el===body?{backgroundColor:'rgb(249, 250, 251)'}:{backgroundColor:'rgb(196, 50, 42)',color:'rgb(255, 255, 255)',visibility:'visible'},
  });
  assert.deepEqual([...actual.styles.button[0].box],[10,20,100,36]);
  assert.equal(actual.styles.button[0].background,'rgb(196, 50, 42)');
  assert.doesNotMatch(JSON.stringify(actual),/业务敏感值|token123/);
});


test('a visually rejected PRD can construct just a hash-bound replacement without approving the original question', () => {
  const file={id:'report-1',format:'png',sha256:'sha',verificationHash:'receipt',questionGeneration:2};
  const job={id:'JOB-1',prd:{auto:true},questionGeneration:2,reportFiles:[file],
    reportEvidence:{status:'verified',binding:{sourceJobId:'JOB-1',fileId:file.id,sha256:file.sha256,verificationHash:file.verificationHash}}};
  const result={outcome:'partial',reportAssessment:{decision:'revise',fileId:file.id},
    investigation:{status:'continue'},documentRequests:[{format:'png'}]};
  const gate={issues:['必需验收项失败：original-question']};
  assert.equal(prdPrototypeRevision(job,result,gate),file);
  assert.equal(prdPrototypeRevision({...job,questionGeneration:3},result,gate),null);
  assert.equal(prdPrototypeRevision(job,{...result,documentRequests:[{format:'md'}]},gate),null);
  assert.equal(prdPrototypeRevision(job,result,{issues:[...gate.issues,'missing source']}),null);
});


test('each assistant uses its app-specific owner and only its group for automatic authorization recovery', async () => {
  const group='oc_team';
  const profiles=['knowledge-ltx','knowledge-oltx','knowledge-tpm','knowledge-salesclub'];
  const publishers=Object.fromEntries(profiles.map((profile,n)=>[profile,{ownerOpenId:'ou_owner'+n,chatIds:[group]}]));
  const questions=Object.fromEntries(profiles.map((profile,n)=>['q'+n,{id:'q'+n,profile,chatId:group,
    prd:{delivery:{phase:'authorization_required',revision:1}}}]));
  questions.q4={id:'q4',profile:profiles[0],chatId:'oc_other',prd:{delivery:{phase:'authorization_required',revision:1}}};
  const state={questions,jobs:Object.keys(questions).map(questionId=>({questionId,status:'completed',
    result:{outcome:'ready'},prd:{auto:true,revision:1,exportRevision:1}}))};
  const calls=[], resumed=[];
  const delivery=new PrdCloudDelivery({store:{read:async()=>state},config:{}},null,{publishers,cli:async (_,args)=>{
    calls.push(args.profile);
    return {ok:args.profile==='knowledge-tpm'};
  }});
  delivery.wake=id=>resumed.push(id);
  await delivery.recover();
  assert.deepEqual(calls.sort(),profiles.toSorted());
  assert.deepEqual(resumed,['q2']);
  assert.equal(delivery.publisherFor(questions.q3,1).ownerOpenId,'ou_owner3');
  assert.equal(delivery.publisherFor(questions.q4,1),null);
});
