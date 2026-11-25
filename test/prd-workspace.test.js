import { PrdCloudDelivery } from '../src/control-plane/prd-cloud-delivery.js';
import { prepareDocumentHandoff, prdPrototypeRevision } from '../src/runner/document-handoff.js';
import { runInNewContext } from 'node:vm';
import { chromeDesignStyle } from '../src/control-plane/shared-chrome-browser.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { questionView } from '../src/control-plane/questions.js';
import { jobCard } from '../src/control-plane/message-cards.js';
import { savePrdDesignReference } from '../src/control-plane/website-evidence.js';
import { generateNativeImage, nativeImageReferences, readPrdDesignReference } from '../src/shared/image-generation.js';
import { producePrdPrototype } from '../src/shared/prd-prototype.js';
import { routePrdWebsiteBrowser, WebsiteBrowser } from '../src/control-plane/website-browser.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonStore } from '../src/shared/store.js';
import { PrdWorkspace } from '../src/control-plane/prd-workspace.js';
import { prdMarkdown } from '../src/control-plane/prd-cloud-delivery.js';
import { prdBusinessAligned, prdBusinessWait, prdFinalContentIssue, prdFinalSections, prdFlowchartIssue, prdDocumentTitle, prdGuidance, prdIntentDigest, prdReviewBasisMissing } from '../src/shared/prd-workspace.js';
import { prdHighlightChanges } from '../src/shared/prd-revision.js';
import { requiresCausalEvidence } from '../src/shared/investigation-review.js';

const chat = 'oc_team';
const owner = 'ou_owner';
const profile = 'knowledge-ltx';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2l8AAAAASUVORK5CYII=', 'base64');
const md = `# 订单补贴状态

## 摘要

订单人员可直接查看**补贴状态**。

## 用户和使用场景

订单人员查看补贴。

## 业务范围

仅查询。

## 操作流程

进入订单页查看状态。

## 功能与业务规则

按订单权限显示。

## 业务口径对齐

仅展示状态，已在卡片确认。

## 跨系统分工

|系统|影响|
|---|---|
|LTX|展示|
|TPM|状态来源|

## 页面设计与原型

无
`;

test('PRD publisher removes byte-matched prototype and input image duplicates from Markdown', () => {
  const source = Buffer.concat([png, Buffer.from([0])]);
  const sourceMarkup = '![' + '初稿' + '](data:image/png;base64,' + source.toString('base64') + ')';
  const prototypeMarkup = '![' + '新原型' + '](data:image/png;base64,' + png.toString('base64') + ')';
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const result = prdMarkdown(md + sourceMarkup + '\n' + prototypeMarkup, {
    prototypeHash: sha(png), referenceHashes: [sha(source)],
  });
  assert.match(result, /初稿图片作为设计参考/);
  assert.match(result, /新原型见文末/);
  assert.match(result, /\|TPM\|状态来源\|/);
  assert.doesNotMatch(result, /base64/);
  assert.throws(() => prdMarkdown(md + sourceMarkup, { prototypeHash: sha(png) }), /PRD_NATIVE_BLOCK_CONTENT/);
  assert.throws(() => prdMarkdown(md + '![外部图](https://example.org/image.png)'), /PRD_NATIVE_BLOCK_CONTENT/);
});

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
    { agent: { systemAssistant: true }, addressed: args.addressed ?? !args.form, content, form: args.form });
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

test('group members can request a PRD after describing the business and keep an existing root on recovery', async t => {
  const { store, send, workspace } = await fixture(t, undefined, { analysisEnvironments: { prd: { tier: 'prd' } } });
  const member = 'ou_group_member';
  const text = '根据PRD环境现有的过期品清货流程，结合新的需求进行方案设计，输出PRD文档：根据客户主数据判断是否进入新流程。';
  for (const [i, other] of ['根据生产数据导出Excel', '解释一下如何输出 PRD 文档', '先查清报错原因，不用生成 PRD 方案', '请分析 PRD 环境的异常'].entries()) {
    assert.equal(await send('om_nonprd'+i, other, null, { event: { sender_id: member } }), null, other);
  }
  const opened = await send('om_member', text, null, { event: { sender_id: member } });
  const first = (await store.read()).jobs.find(j => j.questionId === opened.questionId);
  assert.equal(first.senderId, member);
  assert.equal(first.originalQuestion, text);
  assert.equal(first.taskIntent, 'analysis');
  assert.equal(first.prd.auto, true);
  assert.equal(await send('om_outside', text, null, { event: { sender_id: member, chat_id: 'oc_elsewhere' } }), null);
  assert.equal(await send('om_unaddressed', text, null, { addressed: false, event: { sender_id: member } }), null);

  const previousId = 'QST-existing';
  const oldTurn = { id: 'CHAT-existing', questionId: previousId, status: 'sent', chatId: chat, profile,
    senderId: member, messageId: 'om_existing', projectId: 'ltx', content: text, decision: { action: 'reply' }, createdAt: new Date().toISOString() };
  await store.transact(state => {
    state.conversations.push(oldTurn);
    state.questions[previousId] = { id: previousId, rootTurnId: oldTurn.id, latestTurnId: oldTurn.id, chatId: chat, profile,
      senderId: member, projectId: 'ltx', messageId: oldTurn.messageId, threadRootId: oldTurn.messageId, generation: 1 };
  });
  const event = { chat_type: 'group', chat_id: chat, sender_type: 'user', sender_id: member, agent_profile: profile, message_id: oldTurn.messageId };
  const options = { agent: { systemAssistant: true }, addressed: true, content: text, recoverQuestionId: previousId };
  assert.equal((await workspace.handle({ ...event, sender_id: owner }, options)).reason, 'prd_original_not_recoverable');
  assert.equal((await workspace.handle(event, options)).questionId, previousId);
  assert.equal((await workspace.handle(event, options)).duplicate, true);
  const state = await store.read();
  assert.equal(state.conversations.filter(x => x.questionId === previousId).length, 1);
  assert.equal(state.jobs.filter(x => x.questionId === previousId).length, 1);
  assert.equal(state.jobs.find(j => j.questionId === previousId).replyToMessageId, oldTurn.messageId);
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

test('an environment-free draft link defaults to production even with a test project default', async t => {
  const calls = [];
  const { store, send } = await fixture(t, undefined, { analysisSourceMode: 'isolated',
    defaultSourceEnvironment: 'sit', analysisEnvironments: { sit: {}, release: {runtimeTier:'prd'} } },
    draftFeishu(calls, { environment: '' }));
  const { questionId } = await send('om_prdroot', '我想做个需求');
  await send('om_link', 'https://unit.feishu.cn/docx/DraftToken', 'om_prdroot');
  const state = await store.read();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].questionId, questionId);
  assert.equal(state.jobs[0].sourceEnvironment, 'release');
  assert.match(state.jobs[0].originalQuestion, /LTX订单显示TPM补贴状态/);
  assert.equal(calls.length, 3);
});

test('PRD can verify a shared draft through the bound publisher when the bot can only read it', async t => {
  for (const mode of ['shared', 'wrong-group', 'wrong-owner']) {
    const calls = [];
    const client = draftFeishu(calls);
    client.cloudDocumentMembers = async () => { throw Error('{"code":1063004}'); };
    const { send, store } = await fixture(t, async args => {
      assert.ok(args.includes('user'));
      if (args[0] === 'api') return { data: { open_id: mode === 'wrong-owner' ? 'ou_elsewhere' : owner } };
      assert.notEqual(mode, 'wrong-owner');
      assert.equal(args[1], '+member-list');
      return { data: { items: [{ member_type: 'openchat', member_id: mode === 'shared' ? chat : 'oc_elsewhere', perm: 'view' }] } };
    }, { analysisSourceMode: 'isolated', analysisEnvironments: { sit: {}, prd: {} } }, client);
    await send('om_acl_owner', '我要做一个PRD https://unit.feishu.cn/wiki/DraftWiki');
    const state = await store.read();
    assert.equal(state.jobs.length, mode === 'shared' ? 1 : 0);
    assert.equal(calls.some(([route]) => route.startsWith('/open-apis/docx/')), mode === 'shared');
  }
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

test('PRD ignores unaddressed comments and preserves one question, job and native checkpoint for explicit follow-ups', async t => {
  const { store, workspace, send } = await fixture(t);
  assert.equal(await send('om_regular', '能聊聊 PRD 吗？'), null);
  const { questionId } = await send('om_root', '我要做prd');
  assert.equal((await store.read()).jobs.length, 0);
  assert.equal(await send('om_noise', '在订单详情新增字段', 'om_root', { addressed:false }), null);
  assert.equal((await store.read()).questions[questionId].prd.messages.length,1);
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
    s.questions[questionId].prd.delivery={revision:j.prd.revision,phase:'delivered',sentAt:new Date().toISOString(),url:'https://unit.feishu.cn/docx/OriginalDelivery'};
  });
  const beforeComment = await store.read();
  assert.equal(await send('om_ack','有了','om_root',{addressed:false}),null);
  assert.equal(await send('om_other_mention','换成蓝色','om_root',{addressed:false,event:{mentions:[{id:'ou_other'}]}}),null);
  assert.deepEqual(await store.read(),beforeComment);
  await workspace.resumePending(questionId);
  const state = await store.read();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, first.id);
  assert.equal(state.jobs[0].analysisContinuation.threadId, 'native-thread');
  assert.equal(state.jobs[0].currentQuestion, '只做 PC，隐藏金额');
  assert.equal((await send('om_decision', '只做 PC，隐藏金额', 'om_root')).duplicate, true);
  assert.equal(await send('om_another', '另一条普通消息', 'om_unrelated'), null);
});

test('production is the PRD default and explicit SIT still takes priority', async t => {
  const { store, send } = await fixture(t, undefined, { analysisSourceMode: 'isolated',
    analysisEnvironments: { sit: {}, prd: {} } });
  await send('om_prd', '我要做prd');
  await send('om_request', '【补贴状态 PRD】输出订单详情的需求设计', 'om_prd');
  const { questionId } = await send('om_sit', '我想做个 PRD：使用 SIT 环境设计方案列表');
  const [production,test] = (await store.read()).jobs;
  assert.equal(production.sourceEnvironment, 'prd');
  assert.equal(test.questionId, questionId);
  assert.equal(test.sourceEnvironment, 'sit');
});

test('PRD automatically recovering or stopped updates its card without an escalation', async t => {
  const { store, send } = await fixture(t);
  const {questionId}=await send('om_silent','我要做一个PRD：新增状态');
  const occurredAt=new Date().toISOString();
  await store.transact(state=>{
    const job=state.jobs[0];
    Object.assign(job,{status:'blocked',updatedAt:occurredAt,result:{outcome:'blocked',finalMessage:'需要复核原型'}});
    state.recoveryEvents={demo:{questionId,jobId:job.id,profile:profile,projectId:'ltx',chatId:chat,
      failureAt:occurredAt,status:'maintenance_required',diagnosis:{message:'失败接续文案'}}};
  });
  const projects={humanIdentities:{admin:{[profile]:owner}},failureNotice:{
    enabled:true,humanId:'admin',message:'找我处理',since:'2026-01-01T00:00:00Z'}};
  let view=questionView(await store.read(),questionId,projects);
  assert.equal(view.mention,null);
  assert.doesNotMatch(JSON.stringify(view.card),/接续核查|失败接续文案|找我处理/);
  await store.transact(s=>Object.assign(s.jobs[0],{status:'awaiting_clarification',
    result:{outcome:'needs_clarification',browserLoginRequired:true,browserLoginState:'rejected'}}));
  view=questionView(await store.read(),questionId,projects);
  assert.equal(view.mention,null);
  await store.transact(s=>Object.assign(s.jobs[0],{status:'awaiting_clarification',
    result:{outcome:'needs_clarification',investigation:{blocker:{kind:'user_input',needed:'确认业务规则'}}}}));
  view=questionView(await store.read(),questionId,projects);
  assert.equal(view.mention?.kind,'clarification');
  assert.match(view.mention.text,/卡片的输入框/);
});

test('a single PRD form accepts supplements during execution and switches to revision after delivery', async t => {
  const { cards, store, workspace, send } = await fixture(t);
  const { questionId } = await send('om_live_form', '我想做一个需求，订单详情增加补贴状态');
  await store.transact(s => {
    const job = s.jobs[0];
    job.status = 'running';
    job.analysisContinuation = { questionId, threadId: 'prd-fixed-thread', workspace: '/fixed/workspace' };
    job.analysisSourceSnapshot = { workspace: '/fixed/workspace' };
    job.analysisSourceSnapshots = { prd: job.analysisSourceSnapshot };
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
  assert.equal(updated.analysisSourceSnapshot.workspace, '/fixed/workspace');
  assert.equal(updated.prd.refreshSource, undefined);
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
  assert.equal(formIn(delivered).length, 1);
  assert.equal(formIn(delivered)[0].elements[1].text.content, '提交改版');
  assert.match(JSON.stringify(delivered.card), /https:\/\/unit\.feishu\.cn\/docx\/FinalDoc/);
  const revisionForm = { form: { questionId, cardId:'om_card', version:formIn(delivered)[0].elements[1].name.slice(4) } };
  await send('prd-form:revision','表格加一列更新时间','om_live_form',revisionForm);
  const next=await store.read();
  assert.equal(next.jobs.length,1);
  assert.equal(next.jobs[0].prd.previousRevision.revision,2);
  assert.equal(next.jobs[0].prd.refreshSource,true);
  assert.equal(next.jobs[0].analysisSourceSnapshot,undefined);
  assert.equal(next.jobs[0].analysisSourceSnapshots,undefined);
  assert.equal(next.jobs[0].analysisContinuation.threadId,'prd-fixed-thread');
  assert.match(JSON.stringify((await render()).card),/对照上一版/);
});

test('PRD revision highlights changed text in place and preserves the native table source', () => {
  const baseline = {markdown:'# PRD\n## 规则\n多笔点查看全部打开\n|编号|验收|\n|---|---|\n|AC03|仅查看全部|\n沿用权限'};
  const rendered = prdHighlightChanges(baseline,baseline.markdown.replaceAll('查看全部','查看补贴明细'));
  assert.match(rendered,/多笔点查看<span background-color="light-yellow">补贴明细<\/span>打开/);
  assert.match(rendered,/\|AC03\|仅查看<span background-color="light-yellow">补贴明细<\/span>\|/);
  assert.match(rendered,/\n沿用权限$/);
  assert.doesNotMatch(rendered,/本次变更/);
  assert.equal(prdHighlightChanges(null,'正文'),'正文');
});

test('a PRD display rule about rejection reasons is not a request to investigate a live incident', () => {
  const prd = { revision: 1 };
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '增加状态字段，不展示驳回原因' }), false);
  assert.equal(requiresCausalEvidence({ prd, originalQuestion: '核实这笔补贴被驳回的原因' }), true);
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function saveScreenshot(dataDir, job) {
  const dir=path.join(dataDir,'website-evidence',job.id);
  const item={name:'a-0.png',sha256:hash(png),bytes:png.length,pageUrl:'https://test.example/target'};
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,item.name),png);
  await savePrdDesignReference(dataDir,job,item);
  return item;
}
test('existing-page prototype keeps the captured pixels outside the marked region', async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:320,height:180}});
  await page.setContent('<body style="background:rgb(20,60,80)"></body>');
  const base = await page.screenshot();
  const { store,send,dataDir } = await fixture(t, async()=>{});
  await send('om_prototype','我要做 PRD：订单详情增加按钮');
  const job = (await store.read()).jobs[0], dir=path.join(dataDir,'website-evidence',job.id);
  delete job.prd.inlinePrototypes;
  const item={name:'a-6.png',sha256:hash(base),bytes:base.length,pageUrl:'https://test.example/target'};
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,item.name),base);
  await savePrdDesignReference(dataDir,job,item);
  const recipe = {mode:'existing-page',areas:[{x:.25,y:.4,width:.5,height:.2,text:'查看明细'}]};
  const actual = await producePrdPrototype(dataDir,job,JSON.stringify(recipe),{generate:()=>assert.fail('page should not be redrawn')});
  const result = await page.evaluate(async images => {
    async function pixels(data) {
      const img=new Image(); img.src='data:image/png;base64,'+data; await img.decode();
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      return ctx.getImageData(0,0,img.width,img.height).data;
    }
    const [before,after]=await Promise.all(images.map(pixels));
    let outside=0,inside=0;
    for(let y=0;y<180;y++)for(let x=0;x<320;x++){
      const n=(y*320+x)*4;
      if (before.slice(n,n+4).some((value,k)=>value!==after[n+k])) {
        if(x>=80&&x<240&&y>=72&&y<108)inside++; else outside++;
      }
    }
    return {outside,inside};
  },[base.toString('base64'),actual.bytes.toString('base64')]);
  assert.equal(result.outside,0);
  assert.ok(result.inside>0);
  assert.equal(actual.provenance.inputHashes[0],item.sha256);
  assert.equal(actual.provenance.provider,'prd-screenshot-composite');
  const sideBySide=await producePrdPrototype(dataDir,job,JSON.stringify({mode:'new-page',prompt:'Use existing order UI for a new detail.'}),{
    generate:async ({references})=>{
      assert.equal(references[0].sha256,item.sha256);
      const file=path.join(dataDir,'new-page-proposal.png');
      await fs.writeFile(file,base);
      return {file,root:dataDir,threadId:'test-proposal'};
    }
  });
  assert.equal(sideBySide.bytes.readUInt32BE(16),656);
  assert.equal(sideBySide.bytes.readUInt32BE(20),212);
  assert.equal(sideBySide.provenance.proposedImage.inputHashes[0],item.sha256);

  await assert.rejects(producePrdPrototype(dataDir,job,JSON.stringify({...recipe,areas:[{...recipe.areas[0],width:1}]}),{}),{code:'IMAGE_PROMPT'});
  await assert.rejects(producePrdPrototype(dataDir,{...job,prd:{...job.prd,revision:2}},JSON.stringify(recipe),{}),{code:'IMAGE_LIVE_SCREEN_REQUIRED'});
});

async function saveArtifact(dataDir, job, id, format, bytes, screenshot, generation = job.prd.revision) {
  const dir = path.join(dataDir, 'exports', job.id), item = { id, filename: id + '.' + format, format, kind: 'document',
    sha256: hash(bytes), bytes: bytes.length, rowCount: 0, complete: true, questionGeneration: job.prd.revision };
  await fs.mkdir(dir, { recursive: true });
  const receipt = Buffer.from(JSON.stringify({ version: 2, kind: 'document', status: 'verified',
    binding: { jobId: job.id }, file: item, coverage: { rowCount: 0 },
    ...(screenshot ? {request:{imageGeneration:{status:'verified',provider:'codex-native',sha256:item.sha256,inputHashes:[screenshot.sha256],
      referenceKinds:['website-design-reference'],binding:{jobId:job.id,questionId:job.questionId,projectId:job.projectId,profile:job.originProfile,
        generation,questionHash:hash(String(job.currentQuestion??job.originalQuestion??job.instruction??'')),environment:job.sourceEnvironment}}}} : {}) }));
  await fs.writeFile(path.join(dir, item.filename), bytes);
  await fs.writeFile(path.join(dir, id + '.verification.json'), receipt);
  return { ...item, verificationHash: hash(receipt) };
}

const alignedPrdResult = {
  outcome: 'ready',
  investigation: { status: 'complete', goals: [{ id: 'original-question', required: true, status: 'verified' }] },
  handoff: { checks: [
    { id: 'prd-business-alignment', required: false, status: 'passed', evidence: '发起人确认仅在订单详情显示状态' },
    { id: 'prd-business-purpose', required: true, status: 'passed', evidence: '初稿说明人员核对状态需跨系统；原卡确认在详情查询' },
    { id: 'prd-module-impact', required: true, status: 'passed', evidence: '依据固定源码核对了模块及显示状态的范围，原卡已确认' },
    { id: 'prd-page-fidelity', required: true, status: 'passed', evidence: '已核对适用界面和改动边界' },
    { id: 'prd-design-decisions', required: false, status: 'passed', evidence: [
      '范围及期间：适用｜仅在订单详情展示当前状态',
      '触发及顺序：适用｜进入详情时读取已有结果',
      '权限及状态：适用｜权限沿用原详情，展示审批状态',
      '材料及校验：不适用｜只读展示无上传或导入',
      '例外及后续：适用｜没有审批结果时显示无记录',
    ].join('\n') },
    { id: 'prd-process-design', required: true, status: 'passed', evidence: [
      '现状链路：订单详情读取订单编号，审批系统保存决定',
      '拟议改造及沿用：详情增加状态，审批方式沿用原规则',
      '走查结果：一笔已有审批通过的订单只展示通过状态，不写入订单',
      '证据定位：固定分支的详情状态读取逻辑和原卡确认',
    ].join('\n') },
  ] },
};

test('unanswered PRD decisions return to the form before creating files', async t => {
  const { store, send, dataDir } = await fixture(t, () => assert.fail('No cloud writes'));
  await send('om_waiting', '我要做一个 PRD：订单详情显示状态');
  const [job] = (await store.read()).jobs;
  const needed = '是为了减少跨系统核对，还是另有业务原因？状态以订单记录还是审批结果为准？';
  const result = { ...alignedPrdResult, summary: needed, finalMessage: needed,
    documentRequests: [{ format: 'md', content: md }],
    investigation: { ...alignedPrdResult.investigation, blocker: { kind: 'user_input', needed, evidence: '初稿列了两个来源' } },
    handoff: { artifacts: [], risks: [], returnTo: 'none', checks: [] } };
  const prepared = await prepareDocumentHandoff(job, result, dataDir, {
    dataDir, createFiles: () => assert.fail('Unanswered business decisions cannot create a final file'),
  });
  assert.equal(prepared.result.outcome, 'needs_clarification');
  assert.equal(prepared.result.investigation.blocker.needed, needed);
  assert.equal(prepared.result.investigation.goals[0].status, 'open');
  assert.equal(prdBusinessAligned(job, prepared.result), false);
  assert.equal(prdBusinessAligned(job, alignedPrdResult), true);
});

test('PRD clarification places the actual questions beside the form', () => {
  const job = {prd:{businessFinal:true}};
  const questionList = '1. 只调整扣罚，还是也调整退货额度？\n2. 同批先退货，还是先扣罚？';
  const result = {finalMessage:'请确认以下规则\n'+questionList+'\n技术依据\n1. 已读取现行规则。',
    investigation:{goals:[],blocker:{kind:'user_input',needed:'请在卡片按 finalMessage 确认'}}};
  assert.equal(prdBusinessWait(job,result).investigation.blocker.needed,questionList);
});

test('PRD review requires evidence for purpose, module impact and page fitness', () => {
  const job = { prd: { businessFinal: true, reviewBasis: true } };
  const guidance = prdGuidance(job);
  assert.match(guidance, /业务要求/);
  assert.match(guidance, /让用户确认或补充/);
  assert.match(guidance, /点击后的可见结果/);
  assert.deepEqual(prdReviewBasisMissing(job, alignedPrdResult), []);
  const supplemental = { handoff: { checks: alignedPrdResult.handoff.checks.map(check=>({...check,required:false})) } };
  assert.deepEqual(prdReviewBasisMissing(job, supplemental), []);
  const failed = { handoff: { checks: supplemental.handoff.checks.map(check=>
    check.id==='prd-page-fidelity'?{...check,status:'failed'}:check.id==='prd-business-purpose'?{...check,evidence:' '}:check) } };
  assert.deepEqual(prdReviewBasisMissing(job, failed), ['prd-business-purpose','prd-page-fidelity']);

  const missing = { handoff: { checks: alignedPrdResult.handoff.checks.filter(c=>c.id!=='prd-module-impact') } };
  assert.deepEqual(prdReviewBasisMissing(job, missing), ['prd-module-impact']);
  assert.deepEqual(prdReviewBasisMissing({ prd: { businessFinal: true } }, missing), []);
});

test('new PRD runs receive the process design skill and require all four evidence fields', () => {
  const job = { prd: { reviewBasis: true, processDesign: true } };
  assert.match(prdGuidance(job), /逐个理解独立模块/);
  assert.match(prdGuidance(job), /沿真实依赖往上下游追/);
  assert.doesNotMatch(prdGuidance({}), /流程设计 Skill/);
  assert.deepEqual(prdReviewBasisMissing(job, alignedPrdResult), []);
  const checks = alignedPrdResult.handoff.checks.map(check => check.id === 'prd-process-design'
    ? { ...check, evidence: check.evidence.replace(/走查结果：[^\n]+/, '走查结果：   ') } : check);
  assert.deepEqual(prdReviewBasisMissing(job, { handoff: { checks } }), ['prd-process-design']);
  assert.deepEqual(prdReviewBasisMissing({ prd: { reviewBasis: true } }, { handoff: { checks } }), []);
});

test('complex PRDs require an in-section flowchart and reviewed decision coverage', () => {
  const job = {originalQuestion:'审批完成后对预算占用及上账做分流',prd:{reviewBasis:true,processDesign:true,decisionReview:true}};
  const chart = ['```mermaid','flowchart TD','A["提交"] --> B{"审批通过"}','B -->|是| C["上账"]','```'].join('\n');
  assert.ok(prdFlowchartIssue(job,md));
  assert.equal(prdFlowchartIssue(job,md.replace('## 操作流程\n','## 操作流程\n'+chart+'\n')),null);
  assert.ok(prdFlowchartIssue(job,md+'\n'+chart));
  assert.ok(prdFlowchartIssue({prd:{decisionReview:true}},chart.replace('B -->|是| C["上账"]','click B "https://example.com"')));
  assert.deepEqual(prdReviewBasisMissing(job,alignedPrdResult),[]);
  assert.deepEqual(prdReviewBasisMissing(job,{handoff:{checks:alignedPrdResult.handoff.checks.filter(c=>c.id!=='prd-design-decisions')}}),['prd-design-decisions']);
});

test('PRD final body starts with a prose summary and excludes QA and development sections', () => {
  assert.equal(prdFinalContentIssue(md, true), null);
  assert.equal(prdFinalSections.length, 8);
  assert.match(prdFinalContentIssue(md.replace('## 业务口径对齐\n',''), true), /保留全部/);
  assert.match(prdFinalContentIssue(md.replace('仅展示状态，已在卡片确认。', ''), true), /写「无」/);
  assert.match(prdFinalContentIssue(md.replace('## 页面设计与原型\n\n无', '## 页面设计与原型\n\n弹窗'), true), /登记原型/);
  assert.equal(prdFinalContentIssue(md.replace('## 页面设计与原型\n\n无',
    '## 页面设计与原型\n\n### 弹窗\n\n[[PROTOTYPE:dialog]]'), true), null);
  assert.equal(prdDocumentTitle({ title: '订单跟踪 · 需求初稿' }, 3, true), '订单跟踪 · 需求文档');
  assert.equal(prdDocumentTitle({ title: '我要做一个PRD https://unit.feishu.cn/docx/Draft' }, 3, true, md), '订单补贴状态');
  assert.equal(prdDocumentTitle({ title: '很长的描述'.repeat(20) }, 1, true, '# 订单协查\n\n## 摘要'), '订单协查');
  assert.equal(prdDocumentTitle({ title: '订单跟踪 · 需求初稿' }, 2, true, '# 需求文档\n\n## 摘要'), '订单跟踪');
  assert.match(prdFinalContentIssue('# 订单跟踪\n\n## 摘要\n\n## 业务规则'), /摘要/);
  for (const text of ['## 验收标准', '## 待确认事项', '## 研发实现', '## 版本记录', '|编号|测试用例|']) {
    assert.match(prdFinalContentIssue(md + '\n' + text), /移除/);
  }
});

test('PRD without UI changes retains its prototype section and shares without an image', async t => {
  const calls = [];
  const { workspace, store, send, dataDir } = await fixture(t, async (args, options) => {
    calls.push(args[1]);
    if (args[0] === 'api') return { data: { open_id: owner } };
    if (args[0] === 'auth') return { ok: true, missing: [] };
    if (args[1] === '+create') {
      assert.equal(args[args.indexOf('--title') + 1], '订单补贴状态');
      assert.match(options.input, /## 页面设计与原型\n\n无$/);
      return { data: { document_id: 'NoUiPrototype', url: 'https://unit.feishu.cn/docx/NoUiPrototype' } };
    }
    if (args[1] === '+fetch') return '<h2>摘要</h2><table></table>';
    if (args[1] === '+member-add') return {};
    if (args[1] === '+member-list') return { data: { items: [{ member_id: chat, member_type: 'openchat', perm: 'edit' }] } };
    assert.fail('No image or other cloud writes are needed');
  });
  const { questionId } = await send('om_noui', '我要做一个PRD：变更取数口径');
  const [job] = (await store.read()).jobs;
  const document = await saveArtifact(dataDir, job, 'report-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'md', Buffer.from(md));
  await store.transact(s => {
    Object.assign(s.jobs[0], { status: 'completed', result: alignedPrdResult, reportFiles: [document],
      reportReviews: { [document.id]: { status: 'accepted', verificationHash: document.verificationHash } } });
  });
  await store.transact(s => { s.jobs[0].result = {...alignedPrdResult, handoff:{ checks:[] }}; });
  await workspace.publisher.deliver(questionId);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase,'artifacts_missing');
  assert(!calls.includes('+create'));
  await store.transact(s => { s.jobs[0].result = alignedPrdResult; });
  await workspace.publisher.deliver(questionId);
  const delivery = (await store.read()).questions[questionId].prd.delivery;
  assert.equal(delivery.phase, 'delivered', delivery.notice);
  assert.deepEqual(delivery.artifacts.prototypeIds, []);
  assert(!calls.includes('+media-insert'));
});

test('cross-system PRD delivers styled cloud review draft as the owner with native table/image and scoped editable ACL', async t => {
  const calls = [];
  let image = false;
  const drafts = [];
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
    if (args[1] === '+create') {
      assert.equal(args[args.indexOf('--title') + 1], '订单补贴状态');
      drafts.push(opts.input);
      image=false;
      const token=drafts.length===1?doc:doc+'Second';
      return { data: { document_id: token, url: 'https://unit.feishu.cn/docx/' + token } };
    }
    if (args[1] === '+fetch') return { data: { content: '<h1>订单补贴状态</h1><table/><table><tr><td>TPM</td></tr></table>'
      + (drafts.length>1?'<span background-color="rgba(255,246,122,0.8)">弹窗</span>':'') + (image ? '<img href="owned.png"/>' : '') } };
    if (args[1] === '+media-insert') { image = true; assert.deepEqual(await fs.readFile(path.join(opts.cwd, 'prototype.png')), png); return {}; }
    if (args[1] === '+member-add') { assert.ok(args.includes(chat)); assert.ok(args.includes('openchat')); assert.ok(args.includes('edit')); return {}; }
    if (args[1] === '+member-list') return { data: { items: [{ member_id: chat, member_type: 'openchat', perm: 'edit' }] } };
    throw Error('unexpected CLI');
  };
  const { store, workspace, send, dataDir } = await fixture(t, cli);
  const { questionId } = await send('om_start', '我要写 PRD：LTX 订单详情增加 TPM 补贴状态');
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = alignedPrdResult; delete s.jobs[0].prd.inlinePrototypes; });
  const exportJob = (await store.read()).jobs[0];
  const screenshot = await saveScreenshot(dataDir, exportJob);
  assert.match(prdGuidance(exportJob), /提交一个 md 和一个 png/);
  assert.match(prdGuidance(exportJob), /立即返回 outcome=ready.*reportAssessment.decision=deliver/);
  assert.match(prdGuidance(exportJob), /发布器随后建文档、回读、共享并给原卡回执/);
  assert.match(prdGuidance(exportJob), /收到回执前勿写已送达/);
  const files = await Promise.all([
    saveArtifact(dataDir, exportJob, 'report-11111111-1111-1111-1111-111111111111', 'md', Buffer.from(md)),
    saveArtifact(dataDir, exportJob, 'report-22222222-2222-2222-2222-222222222222', 'png', png, screenshot, null),
  ]);
  await store.transact(s => {
    const j = s.jobs[0];
    j.status = 'completed';
    j.result = alignedPrdResult;
    j.reportFiles = files;
    j.reportReviews = Object.fromEntries(files.map(f => [f.id, { status: 'accepted', verificationHash: f.verificationHash }]));
    s.questions[questionId].prd.delivery = { revision: exportJob.prd.revision, phase: 'artifacts_missing',
      digest: prdIntentDigest([questionId, chat, exportJob.prd.revision, exportJob.prd.revision, ...files.map(f => f.sha256)]) };
  });
  await store.transact(s => { s.jobs[0].currentQuestion = '另一轮请求'; });
  await workspace.publisher.deliver(questionId);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase, 'artifacts_missing');
  assert.equal(calls.length, 0);
  await store.transact(s => { s.jobs[0].currentQuestion = exportJob.currentQuestion; });
  await workspace.publisher.recover({ recheckArtifacts: true });
  await workspace.publisher.workers.get(questionId);
  await workspace.publisher.deliver(questionId);
  await workspace.publisher.deliver(questionId);
  const d = (await store.read()).questions[questionId].prd.delivery;
  assert.equal(d.phase, 'delivered', d.notice);
  assert.ok(d.sentAt);
  assert.equal(calls.filter(([a]) => a[1] === '+create').length, 1);
  assert.equal(calls.filter(([a]) => a[1] === '+member-add').length, 1);
  assert.equal(drafts[0],md.trim());
  await send('om_revision','请把 LTX 的展示改成弹窗','om_start');
  await store.transact(s => { delete s.jobs[0].prd.inlinePrototypes; });
  const next = (await store.read()).jobs[0];
  const secondScreenshot=await saveScreenshot(dataDir,next);
  const revised=await Promise.all([
    saveArtifact(dataDir,next,'report-99999999-9999-9999-9999-999999999991','md',Buffer.from(md.replace('|LTX|展示|','|LTX|弹窗|'))),
    saveArtifact(dataDir,next,'report-99999999-9999-9999-9999-999999999992','png',png,secondScreenshot),
  ]);
  await store.transact(s=>{
    const j=s.jobs[0];j.status='completed';j.result=alignedPrdResult;
    j.reportFiles.push(...revised);
    for(const f of revised)j.reportReviews[f.id]={status:'accepted',verificationHash:f.verificationHash};
  });
  await workspace.publisher.deliver(questionId);
  const after=(await store.read()).questions[questionId].prd;
  assert.equal(after.delivery.phase,'delivered',after.delivery.notice);
  assert.equal(after.delivery.revision,2);
  assert.equal(after.deliveryHistory[1].url,d.url);
  assert.doesNotMatch(drafts[1],/本次变更/);
  assert.match(drafts[1],/LTX\|<span background-color="light-yellow">弹窗<\/span>/);
  assert.throws(() => prdMarkdown(md + '![remote](https://example.com/pixel.png)'));
});

test('missing owner authorization never creates a document or expands sharing', async t => {
  const { workspace, store, send, dataDir } = await fixture(t, async args => {
    assert.equal(args[0], 'api');
    return { data: { open_id: 'ou_wrong_account' } };
  });
  const { questionId } = await send('om_start', '我要做PRD：新增状态');
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = alignedPrdResult; delete s.jobs[0].prd.inlinePrototypes; });
  const j = (await store.read()).jobs[0];
  const screenshot = await saveScreenshot(dataDir, j);
  const files = await Promise.all([
    saveArtifact(dataDir, j, 'report-33333333-3333-3333-3333-333333333333', 'md', Buffer.from(md)),
    saveArtifact(dataDir, j, 'report-44444444-4444-4444-4444-444444444444', 'png', png, screenshot),
  ]);
  await store.transact(s => { Object.assign(s.jobs[0], { status: 'completed', result: alignedPrdResult, reportFiles: files }); });
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
  await store.transact(s => { s.jobs[0].status = 'completed'; s.jobs[0].result = alignedPrdResult; delete s.jobs[0].prd.inlinePrototypes; });
  const [job] = (await store.read()).jobs;
  const screenshot = await saveScreenshot(dataDir, job);
  const files = await Promise.all([
    saveArtifact(dataDir, job, 'report-55555555-5555-5555-5555-555555555555', 'md', Buffer.from(md)),
    saveArtifact(dataDir, job, 'report-66666666-6666-6666-6666-666666666666', 'png', png, screenshot),
  ]);
  await store.transact(s => { Object.assign(s.jobs[0], { status: 'completed', result: alignedPrdResult, reportFiles: files }); });
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
  assert.deepEqual(job.prd,{revision:2,exportRevision:2,auto:true,businessFinal:true,reviewBasis:true,processDesign:true,decisionReview:true,fixedFinalSections:true,inlinePrototypes:true,nativePrototypeEdits:true,nativeUiCapture:true});
  assert.equal(job.currentQuestion,'不展示金额。');
});

test('website design references are hash-bound to the real page capture, job, environment and revision', async t => {
  const {dataDir} = await fixture(t);
  const job={id:'JOB-design',questionId:'QST-design',projectId:'ltx',originProfile:profile,sourceEnvironment:'sit',prd:{auto:true,revision:2}};
  const dir=path.join(dataDir,'website-evidence',job.id);
  const item=await saveScreenshot(dataDir,job);
  assert.deepEqual(await nativeImageReferences(dataDir,job),[{path:path.join(dir,item.name),sha256:item.sha256,kind:'website-design-reference'}]);
  assert.deepEqual(await nativeImageReferences(dataDir,{...job,prd:{...job.prd,revision:3}}),[]);
  await assert.rejects(nativeImageReferences(dataDir,{...job,sourceEnvironment:'prd'}),{code:'IMAGE_INPUT'});
  await assert.rejects(nativeImageReferences(dataDir,{...job,projectId:'tpm'}),{code:'IMAGE_INPUT'});
  const next={...job,prd:{...job.prd,revision:3},attachments:[{type:'image',path:path.join(dir,item.name)}]};
  await assert.rejects(generateNativeImage(dataDir,next,'在详情页加入状态',{generate:()=>assert.fail('Never generate without a live screenshot')}),{code:'IMAGE_LIVE_SCREEN_REQUIRED'});
});

test('Feishu delivery does not accept a prototype made without the current screenshot receipt', async t => {
  const {store,workspace,send,dataDir}=await fixture(t,()=>assert.fail('Never create a cloud draft without verified visual evidence'));
  const {questionId}=await send('om_unsourced','我想做一个需求，新增订单状态');
  await store.transact(s => { delete s.jobs[0].prd.inlinePrototypes; });
  const [job]=(await store.read()).jobs;
  await saveScreenshot(dataDir,job);
  const files=await Promise.all([
    saveArtifact(dataDir,job,'report-77777777-7777-7777-7777-777777777777','md',Buffer.from(md)),
    saveArtifact(dataDir,job,'report-88888888-8888-8888-8888-888888888888','png',png),
  ]);
  await store.transact(s=>Object.assign(s.jobs[0],{status:'completed',result:alignedPrdResult,reportFiles:files}));
  await workspace.publisher.deliver(questionId);
  assert.match((await store.read()).questions[questionId].prd.delivery.notice,/真实目标页面截图/);
});

test('PRD website actions and login recovery use the same isolated browser', async () => {
  const browser = name=>({run:()=>name,loginStatusFor:()=>name,captureLoginQr:()=>name,beginInteractiveLogin:()=>name});
  const route=routePrdWebsiteBrowser(browser('shared'),browser('isolated'));
  assert.equal(route.run({}), 'shared');
  const prd={prd:{auto:true}};
  assert.equal(route.run(prd), 'isolated');
  assert.equal(route.loginStatusFor(prd), 'isolated');
  assert.equal(route.captureLoginQr(prd), 'isolated');
  const qrEntry={loginNavigation:{remoteQr:true}};
  assert.equal(route.run({},qrEntry), 'isolated');
  assert.equal(route.loginStatusFor({},qrEntry), 'isolated');
  assert.equal(route.beginInteractiveLogin({},qrEntry), 'isolated');
  assert.equal(route.captureLoginQr({},qrEntry), 'isolated');
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

test('a structurally verified replacement PNG can be saved while the original visual requirement remains open', async t => {
  const {dataDir}=await fixture(t);
  const job={id:'JOB-revision',questionId:'QST-revision',taskIntent:'analysis',questionGeneration:1,prd:{auto:true,revision:1}};
  const original=await saveArtifact(dataDir,job,'report-12345678-1234-1234-1234-123456789abc','png',png);
  const replacement=await saveArtifact(dataDir,job,'report-12345678-1234-1234-1234-123456789abd','png',Buffer.concat([png,Buffer.from([0])]));
  job.reportFiles=[original];
  job.reportEvidence={status:'verified',binding:{sourceJobId:job.id,fileId:original.id,sha256:original.sha256,verificationHash:original.verificationHash}};
  job.prd.inlinePrototypes=true;
  const second=await saveArtifact(dataDir,job,'report-12345678-1234-1234-1234-123456789abe','png',Buffer.concat([png,Buffer.from([1])]));
  const events=[];
  const {result}=await prepareDocumentHandoff(job,{
    outcome:'partial',reportAssessment:{decision:'revise',fileId:original.id},documentRequests:[{format:'png'},{format:'png'}],
    investigation:{status:'continue',goals:[{id:'original-question',status:'open'}]},
    handoff:{returnTo:'none',artifacts:[],risks:[],checks:[{id:'original-question',required:true,status:'failed',evidence:'原页面布局未保留'}]},
  },dataDir,{dataDir,createFiles:async()=>[replacement,second],emit:async e=>events.push({...e,at:new Date().toISOString()})});
  assert.equal(result.handoffGate.passed,true);
  assert.equal(result.outcome,'partial');
  assert.equal(result.reportReviewRequired,true);
  assert.deepEqual(result.exportFiles,[replacement,second]);
  assert.equal(result.handoff.checks.find(c=>c.id==='original-question').status,'not_run');
  const card=jobCard({...job,status:'running',createdAt:events[0].at,events});
  assert.equal(card.header.template,'blue');
  assert.match(JSON.stringify(card),/原型正在修订/);
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

test('PRD keeps a separate screenshot and places each prototype under its own requirement', async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:360,height:220}});
  const doc = 'NativeDocumentToken';
  const blocks = [];
  const text = (id, content) => ({block_id:id, text:{elements:[{text_run:{content}}]}});
  const cli = async (args, options) => {
    if (args[0] === 'auth') return {ok:true};
    if (args[0] === 'api') return {data: args[2].includes('user_info') ? {open_id:owner} : {items:structuredClone(blocks)}};
    if (args[1] === '+create') {
      assert.match(options.input, /## 菜单[\s\S]*AGENTOSPRDFIGURE-menu[\s\S]*## 列表[\s\S]*AGENTOSPRDFIGURE-list/);
      blocks.push(text('anchor1','AGENTOSPRDFIGURE-menu'),text('heading2','列表'),text('anchor2','AGENTOSPRDFIGURE-list'));
      return {data:{document_id:doc,url:'https://unit.feishu.cn/docx/'+doc}};
    }
    if (args[1] === '+fetch') return {data:{content:'<h1>需求</h1><table></table><img />'}};
    if (args[1] === '+media-insert') {
      const bytes = await fs.readFile(path.join(options.cwd,'prototype.png'));
      const image = hash(bytes);
      blocks.push({block_id:image,block_type:27,image:{token:image}});
      return {};
    }
    if (args[1] === '+update') {
      const arg = key => args[args.indexOf(key)+1];
      if (arg('--command') === 'block_move_after') {
        const index=blocks.findIndex(b=>b.block_id===arg('--src-block-ids'));
        assert.notEqual(blocks[index-1]?.block_id,arg('--block-id'),'Feishu rejects moves to the existing position');
        const [image] = blocks.splice(index,1);
        blocks.splice(blocks.findIndex(b=>b.block_id===arg('--block-id'))+1,0,image);
      } else {
        const anchor = blocks.find(b=>b.text?.elements[0].text_run.content===arg('--pattern'));
        anchor.text.elements[0].text_run.content=arg('--content');
      }
      return {};
    }
    if (args[1] === '+member-add') return {};
    if (args[1] === '+member-list') return {data:{items:[{member_id:chat,member_type:'openchat',perm:'edit'}]}};
    assert.fail('unexpected CLI');
  };
  const { store,send,dataDir,workspace } = await fixture(t,cli);
  const { questionId } = await send('om_inline','我想做一个需求，新增 LTX 菜单和 TPM 查询列表');
  await store.transact(s=>{
    s.questions[questionId].generation=3;
    Object.assign(s.jobs[0].prd,{revision:2,exportRevision:2});
  });
  const [job] = (await store.read()).jobs;
  const dir = path.join(dataDir,'website-evidence',job.id);
  const website = new WebsiteBrowser(dataDir);
  website.loginStatus = async () => ({loginRequired:false});
  const editor = await browser.newPage({viewport:{width:360,height:220}});
  await editor.setContent('<body style="background:#0a62b0"></body>');
  const modelOutput=path.join(dataDir,'native-editor.png');
  const figures = [];
  for (const [n,key] of ['menu','list'].entries()) {
    const color = n ? '#f3f4f6' : '#e9f1ff';
    const url = 'https://test.example/'+key;
    const logo = n ? 'wlBig.8f1f5.svg' : 'logoImg.8f1f5.svg';
    await page.route('https://test.example/assets/'+logo,route=>route.fulfill({contentType:'image/svg+xml',
      body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'}));
    await page.route(url,route=>route.fulfill({contentType:'text/html; charset=utf-8',
      body:'<header><span class="brand-mark" style="display:inline-block;width:20px;height:20px;background-image:url(/assets/'+logo+')"></span><img '+(n?'class="default-logo" ':'')+'src="/assets/'+logo+'"><svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="green"/></svg></header>'
        +'<button style="padding:8px 20px;background:'+color+'">查询</button>'
        + '<nav><a>渠道经营复盘</a><span class="user-info">示例用户名</span></nav><div class="ant-collapse-header">例外处理</div>'
        + (n ? '<table><tr><th>分配金额</th></tr><tr><td id="business">AA123456</td></tr><tr><td>BB222222</td></tr></table>'
          : '<label for="budget">预算来源：</label><input id="budget" value="DEMO-PRIVATE"><div id="business">AA123456</div>')}));
    await page.goto(url);
    const capture = () => website.screenshot({page,job},{url,targetText:'查询'});
    const snapshot = await capture();
    assert.equal(snapshot.designLayout.controls[0].text,'查询');
    assert.deepEqual(snapshot.designLayout.controls.map(control=>control.text),['查询','渠道经营复盘','例外处理',n?'分配金额':'预算来源：']);
    assert.doesNotMatch(JSON.stringify(snapshot.designLayout.controls),/DEMO-PRIVATE|AA123456|示例用户名/);
    assert.equal(snapshot.designReference.visualPolicy,'brand-layout-v7');
    assert.equal(snapshot.designLayout.assets.length,2);
    assert.equal(snapshot.designLayout.backgrounds.length,1);
    assert.equal(snapshot.designLayout.brandRegions.length,2);
    assert.ok(snapshot.designLayout.actionRegions.length);
    const base = await fs.readFile(path.join(dir,snapshot.designReference.name));
    if (!n) {
      await page.locator('#business').evaluate(el=>{el.textContent='BB999999';});
      assert.equal((await capture()).designReference.sha256,hash(base),'business text remains redacted');
    }
    const referenceId = await savePrdDesignReference(dataDir,job,snapshot.designReference);
    const future={...job,prd:{...job.prd,revision:job.prd.revision+1}};
    const reused=await readPrdDesignReference(dataDir,future,referenceId);
    assert.equal(reused?.sha256,hash(base));
    assert.equal(await readPrdDesignReference(dataDir,{...future,analysisSourceSnapshot:{cacheKey:'new-source'}},referenceId),undefined);
    const actual = await producePrdPrototype(dataDir,job,JSON.stringify({
      mode:n?'new-page':'existing-page', prototypeKey:key, referenceId,
      prompt:'保留真实界面，在修改区增加查看活动入口',
      areas:[{x:.25,y:.4,width:.5,height:.2},snapshot.designLayout.brandRegions[0],snapshot.designLayout.actionRegions[0]],
    }),{generate:async ({references,editReference,prompt})=>{
      assert.equal(editReference,true);
      assert.equal(references[0].sha256,hash(base));
      assert.match(prompt,/查看活动入口/);
      await editor.screenshot({path:modelOutput});
      return {file:modelOutput,root:dataDir,threadId:'test-native-editor',model:'gpt-image-2'};
    }});
    assert.equal(actual.bytes.readUInt32BE(16),360);
    assert.equal(actual.bytes.readUInt32BE(20),220);
    assert.equal(actual.provenance.inputHashes[0],hash(base));
    assert.equal(actual.provenance.provider,'prd-native-image-edit');
    assert.equal(actual.provenance.proposedImage.model,'gpt-image-2');
    const outsideUnchanged=await page.evaluate(async images=>{
      const outside=async bytes=>{
        const img=new Image();img.src='data:image/png;base64,'+bytes;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
        return ctx.getImageData(0,0,img.width,88).data;
      };
      const [before,after]=await Promise.all(images.map(outside));
      return before.every((value,index)=>value===after[index]);
    },[base.toString('base64'),actual.bytes.toString('base64')]);
    assert.ok(outsideUnchanged);
    if(n){
      const [row]=snapshot.designLayout.tableRows;
      assert(row?.height>0);
      const {x,y,width,height}=row;
      const area={x,y,width,height};
      const existingRecipe={mode:'existing-page',prototypeKey:key,referenceId,prompt:'在原有参数前插入新行',areas:[area]};
      await assert.rejects(producePrdPrototype(dataDir,job,JSON.stringify(existingRecipe),{
        generate:async()=>assert.fail('Must protect existing rows before calling image editor'),
      }), /覆盖现有表格行/);
      const body=snapshot.designLayout.tableBodies[0];
      assert(body?.height>=height*2-.002);
      await assert.rejects(producePrdPrototype(dataDir,job,JSON.stringify({...existingRecipe,
        shifts:[{...area,height:body.height+.02,dy:height}],
      }),{generate:async()=>assert.fail('Must reject overflow before generating')}), /越过原表格滚动容器/);
      const pitch=snapshot.designLayout.tableRows[1].y-y;
      const shifts=[{...area,height:body.y+body.height-y,dy:pitch}];
      const shifted=await producePrdPrototype(dataDir,job,JSON.stringify({...existingRecipe,shifts}),{
        generate:async()=>{await editor.screenshot({path:modelOutput});return {file:modelOutput,root:dataDir,threadId:'test-row-shift',model:'gpt-image-2'};},
      });
      const rowIntact=await page.evaluate(async ({images,row,pitch})=>{
        const pixels=async (bytes,offset)=>{
          const img=new Image();img.src='data:image/png;base64,'+bytes;await img.decode();
          const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
          const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
          return ctx.getImageData(Math.round(row.x*img.width),Math.round((row.y+offset)*img.height),
            Math.round(row.width*img.width),Math.round(row.height*img.height)).data;
        };
        const [a,b]=await Promise.all([pixels(images[0],0),pixels(images[1],pitch)]);
        return a.every((value,index)=>value===b[index]);
      },{images:[base.toString('base64'),shifted.bytes.toString('base64')],row,pitch});
      assert(rowIntact);
    }
    if (!n) {
      const partial=await producePrdPrototype(dataDir,job,JSON.stringify({
        mode:'existing-page',prototypeKey:key,referenceId,prompt:'只展示提示',
        areas:[{x:.35,y:.5,width:.2,height:.1}],
        focusCrop:{x:.25,y:.4,width:.5,height:.3},
      }),{generate:async()=>({file:modelOutput,root:dataDir,threadId:'test-local-prompt'})});
      assert.deepEqual([partial.bytes.readUInt32BE(16),partial.bytes.readUInt32BE(20)],[180,66]);
    }
    await assert.rejects(producePrdPrototype(dataDir,job,JSON.stringify({
      mode:'new-page',prototypeKey:key,referenceId,prompt:'测试控件裁切',
      areas:[{x:.25,y:.45,width:.4,height:.2,fit:'control'}],
    }),{generate:async()=>{await editor.screenshot({path:modelOutput});return {file:modelOutput,root:dataDir,threadId:'test-control-edge',model:'gpt-image-2'};}}), /裁切边缘/);
    const final = n ? await producePrdPrototype(dataDir,job,JSON.stringify({mode:'reference-only',prototypeKey:key,referenceId}),{
      generate:async()=>assert.fail('An unchanged reference must not use image generation'),
    }) : actual;
    if(n)assert.deepEqual(final.bytes,base);
    const artifact = await saveArtifact(dataDir,{...job,prd:{...job.prd,revision:3}},'report-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'.slice(0,-1)+n,'png',final.bytes);
    const receiptPath=path.join(dataDir,'exports',job.id,artifact.id+'.verification.json');
    const receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));
    const updated=Buffer.from(JSON.stringify({...receipt,request:{imageGeneration:final.provenance}}));
    await fs.writeFile(receiptPath,updated);
    figures.push({...artifact,verificationHash:hash(updated)});
  }
  const markdown=await saveArtifact(dataDir,{...job,prd:{...job.prd,revision:1}},'report-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','md',
    Buffer.from(md.replace('## 页面设计与原型\n\n无','## 页面设计与原型\n\n### 菜单\n\n[[PROTOTYPE:menu]]\n\n### 列表\n\n[[PROTOTYPE:list]]')));
  const files=[markdown,...figures];
  await store.transact(s=>Object.assign(s.jobs[0],{status:'completed',result:alignedPrdResult,reportFiles:files,
    reportReviews:Object.fromEntries(files.map(f=>[f.id,{status:'accepted',verificationHash:f.verificationHash}]))}));
  await workspace.publisher.deliver(questionId);
  const pending=(await store.read()).questions[questionId].prd.delivery;
  assert.equal(pending.phase,'artifacts_missing');
  assert.equal(blocks.length,0);
  await store.transact(s=>{
    s.jobs[0].result={...alignedPrdResult,handoffGate:{passed:true},
      reportAssessment:{decision:'deliver',coverage:'complete',issues:[],
        deliverables:[{fileId:markdown.id,evidence:'This revision reviewed the unchanged business text'}]},
      reportInspections:[{status:'verified',contentAudit:{structure:'passed'},
        binding:{sourceJobId:job.id,fileId:markdown.id,sha256:markdown.sha256,verificationHash:markdown.verificationHash}}]};
  });
  await store.transact(s=>{s.jobs[0].currentQuestion='不同的业务要求';});
  await workspace.publisher.deliver(questionId);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase,'artifacts_missing');
  assert.equal(blocks.length,0);
  await store.transact(s=>{s.jobs[0].currentQuestion=job.currentQuestion;});
  await workspace.publisher.deliver(questionId);
  const delivered=(await store.read()).questions[questionId].prd.delivery;
  assert.equal(delivered.phase,'delivered');
  assert.equal(delivered.artifacts.generation,3);
  assert.equal(delivered.artifacts.markdownGeneration,1);
  assert.notEqual(delivered.digest,pending.digest);
  assert.deepEqual(blocks.map(b=>b.image?.token??b.block_id),['anchor1',figures[0].sha256,'heading2','anchor2',figures[1].sha256]);
  assert.equal(blocks[0].text.elements[0].text_run.content,'界面原型（拟议）');
  assert.equal(blocks[3].text.elements[0].text_run.content,'现状实拍（已脱敏）');
});

test('PRD text revision can rebind a failed pre-creation record to a reviewed unchanged screenshot', async t => {
  let checkedPublisher = 0;
  const {store, workspace, send, dataDir} = await fixture(t, async args => {
    assert.equal(args[0], 'api');
    checkedPublisher++;
    return {data:{open_id:'intentionally-wrong-owner'}};
  });
  const {questionId} = await send('om_text_revision', '我要做PRD：订单详情增加信息');
  const [prior] = (await store.read()).jobs;
  prior.analysisSourceSnapshot = {cacheKey:'verified-source'};
  const referenceId = '99999999-9999-4999-8999-999999999999';
  const item = {name:referenceId+'.png',sha256:hash(png),bytes:png.length,
    visualPolicy:'brand-layout-v6',pageUrl:'https://test.example/target'};
  const dir = path.join(dataDir,'website-evidence',prior.id);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,item.name),png);
  assert.equal(await savePrdDesignReference(dataDir,prior,item),referenceId);
  const image = await saveArtifact(dataDir,prior,'report-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9','png',png);
  const receiptPath = path.join(dataDir,'exports',prior.id,image.id+'.verification.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath,'utf8'));
  receipt.request = {imageGeneration:{status:'verified',provider:'prd-live-screenshot',mode:'reference-only',
    prototypeKey:'order',referenceId,sha256:image.sha256,inputHashes:[item.sha256],referenceKinds:['website-design-reference'],
    binding:{jobId:prior.id,questionId,projectId:prior.projectId,profile,environment:prior.sourceEnvironment,
      generation:1,questionHash:hash(prior.originalQuestion)}}};
  const verifiedReceipt = JSON.stringify(receipt);
  await fs.writeFile(receiptPath,verifiedReceipt);
  image.verificationHash = hash(verifiedReceipt);
  const next = {...prior,prd:{...prior.prd,revision:2,exportRevision:2}};
  const body = md.replace('## 页面设计与原型\n\n无','## 页面设计与原型\n\n[[PROTOTYPE:order]]');
  const markdown = await saveArtifact(dataDir,next,'report-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8','md',Buffer.from(body));
  const result = {...alignedPrdResult,handoffGate:{passed:true},
    reportAssessment:{decision:'deliver',coverage:'complete',issues:[],deliverables:[{fileId:image.id,evidence:'图已复核'}]},
    reportInspections:[{status:'verified',contentAudit:{structure:'passed'},
      binding:{sourceJobId:prior.id,fileId:image.id,sha256:image.sha256,verificationHash:image.verificationHash}}]};
  const initialDigest = prdIntentDigest([questionId,chat,2,2,markdown.sha256]);
  await store.transact(s => {
    const q = s.questions[questionId];
    q.generation = 2;
    q.prd.delivery = {revision:2,digest:initialDigest,phase:'artifacts_missing'};
    Object.assign(s.jobs[0],next,{status:'completed',result,reportFiles:[image,markdown],
      analysisSourceSnapshot:{cacheKey:'changed-source'}});
  });
  await workspace.publisher.deliver(questionId);
  assert.equal(checkedPublisher,0);
  await store.transact(s => {
    s.jobs[0].analysisSourceSnapshot = prior.analysisSourceSnapshot;
    s.jobs[0].result.reportInspections = [];
  });
  await workspace.publisher.deliver(questionId);
  assert.equal(checkedPublisher,0);
  assert.equal((await store.read()).questions[questionId].prd.delivery.digest,initialDigest);
  await store.transact(s => { s.jobs[0].result.reportInspections = result.reportInspections; });
  await workspace.publisher.deliver(questionId);
  assert.equal(checkedPublisher,1);
  assert.equal((await store.read()).questions[questionId].prd.delivery.phase,'authorization_required');
});

test('registered Markdown may be handed off as a PRD without looking in the source checkout', async t => {
  const { dataDir } = await fixture(t);
  const workspace=path.join(dataDir,'source-fixture');
  await fs.mkdir(workspace,{recursive:true});
  const { validateHandoff } = await import('../src/runner/harness.js');
  const job={id:'JOB-prd-handoff',questionGeneration:2,prd:{auto:true,revision:2}};
  const bytes=Buffer.from('# PRD\n\nBusiness requirement.');
  const id='report-00000000-0000-4000-8000-000000000001';
  job.reportFiles=[{...await saveArtifact(dataDir,job,id,'md',bytes),sourceJobId:job.id}];
  const result={outcome:'partial',handoff:{artifacts:[{kind:'prd',path:id+'.md'}],checks:[{id:'original-question',required:true,status:'passed',evidence:'Verified Markdown'}],risks:['Prototype pending'],returnTo:'none'}};
  const probe={...job,stage:'developer',taskIntent:'analysis',questionId:'q'};
  const pass=await validateHandoff(probe,result,workspace,{dataDir});
  assert.deepEqual(pass.issues,[]);
  assert.equal(pass.verifiedArtifacts[0].fileId,id);
  for(const other of [{...probe,questionGeneration:3},{...probe,prd:undefined},{...probe,id:'other-job'}]){
    assert((await validateHandoff(other,result,workspace,{dataDir})).issues.length);
  }
});

test('publisher startup recovers a completed revision even when the preceding revision was delivered', async () => {
  const q={id:'q',prd:{delivery:{phase:'delivered',revision:1}}};
  const job={questionId:'q',status:'completed',result:{outcome:'ready'},prd:{revision:2,exportRevision:2,auto:true}};
  const delivery=new PrdCloudDelivery({store:{read:async()=>({questions:{q},jobs:[job]})}},null);
  const resumed=[];
  delivery.wake=id=>resumed.push(id);
  await delivery.recover();
  assert.deepEqual(resumed,['q']);
  q.prd.delivery.revision=2;
  await delivery.recover();
  assert.deepEqual(resumed,['q']);
});
