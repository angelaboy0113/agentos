import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jobCard, conversationCard } from '../src/control-plane/message-cards.js';
import { resultPages, readableMarkdown, publicText, detailVersion } from '../src/control-plane/result-presentation.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { JsonStore } from '../src/shared/store.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { buildPrompt } from '../src/runner/codex-executor.js';

test('all roles lead with a short answer and keep full technical evidence folded', async () => {
  for (const stage of ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report']) {
    const job = { id: 'J', stage, projectName: '测试', status: 'completed', result: {
      summary: '已找到登录校验入口；只查了源码，没有改代码。线上配置尚未验证。',
      finalMessage: '# 详细证据\n' + '具体实现与文件行号。\n'.repeat(2000),
    }, events: [] };
    const card = jobCard(job);
    assert.match(card.body.elements[0].columns[0].elements[1].content, /线上配置尚未验证/);
    assert.ok(card.body.elements[0].columns[0].elements[1].content.length < 360);
    assert.equal(card.body.elements.find((e) => e.tag === 'collapsible_panel').expanded, false);
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
    assert.doesNotMatch(JSON.stringify(card), /结论续文|D:\\|^###/);
    assert.match(await buildPrompt(job, {}), /summary 用 2–4 句/);
  }
});

test('legacy HTML is escaped once, file links become readable labels and fences balance per page', () => {
  const source = '### 调查结论\n[Result.java:17](/D:/work/project/src/Result.java:17)\n'
    + '```json\n' + '  {"示例": "&#60;用户ID&#62;"},\n'.repeat(400) + '```\n结尾证据';
  const clean = readableMarkdown(source);
  assert.match(clean, /\*\*调查结论\*\*/);
  assert.doesNotMatch(clean, /D:\/work|&amp;#60/);
  const pages = resultPages(source);
  assert.ok(pages.length > 2);
  for (const page of pages) {
    assert.equal((page.match(/^```/gm) ?? []).length % 2, 0);
    assert.ok(Buffer.byteLength(page) < 12000);
  }
  assert.match(pages.at(-1), /结尾证据/);
  assert.doesNotMatch(publicText('api_key="secret" &lt;at id=all&gt;'), /secret|<at/);
  assert.equal(publicText(publicText('<user> & text')), publicText('<user> & text'));
});

test('chat and job pagination updates same card, survives retries, rejects wrong scope and never mutates jobs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-result-pages-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let sends = 0, texts = 0, fail = false;
  const client = { sendCard: async () => ({ message_id: `om_${++sends}` }), replyCard: async () => ({ message_id: `om_${++sends}` }),
    updateCard: async () => { if (fail) throw new Error('offline'); }, reply: async () => { texts++; } };
  const cards = new LiveCards(store, client, { intervalMs: 0 });
  t.after(async () => { await cards.stop(); await rm(dir, { recursive: true, force: true }); });
  const context = { store, cards, feishu: client, projects: { ownerOpenIdsByProfile: { owner: ['admin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' } } } };
  const text = '详情段落和风险。\n'.repeat(600);
  const { job } = await store.createJob({ instruction: '只读', projectId: 'p', chatId: 'group', stage: 'owner_intake',
    agentProfile: 'owner', originProfile: 'owner', senderId: 'creator', status: 'completed' });
  const turn = { id: 'c', status: 'sent', role: 'owner_intake', chatId: 'group', profile: 'owner', senderId: 'creator', response: text };
  await store.transact((state) => { state.conversations = [turn]; });
  for (const [key, card] of [[`job:${job.id}:first`, jobCard({ ...job, result: { summary: '概要；风险待验证。', finalMessage: text } })], ['chat:c', conversationCard(turn)]]) {
    const id = await cards.upsert(key, card, { chatId: 'group', profile: 'owner' }, { terminal: true, immediate: true, resultText: text });
    const beforeJobs = JSON.stringify((await store.read()).jobs);
    const event = { type: 'card.action.trigger', event_id: `${key}:page`, operator_id: 'creator', agent_profile: 'owner',
      chat_id: 'group', message_id: id, card_content: JSON.stringify(card), action_value: { action: 'result_page', page: 1, version: detailVersion(resultPages(text)) } };
    for (const extra of [{ operator_id: 'other' }, { chat_id: 'other' }, { agent_profile: 'dev' }, { action_value: { ...event.action_value, page: 999 } }]) {
      assert.notEqual((await handleCardAction(context, { ...event, ...extra })).ok, true);
    }
    fail = true;
    assert.equal((await handleCardAction(context, event)).ok, false);
    fail = false;
    assert.equal((await handleCardAction(context, event)).ok, true);
    const saved = (await store.read()).cardMessages[key];
    assert.equal(saved.messageId, id);
    assert.equal(saved.card.body.elements.at(-1).expanded, true);
    assert.match(saved.card.body.elements.at(-1).header.title.content, /2\//);
    assert.equal(JSON.stringify((await store.read()).jobs), beforeJobs);
    assert.equal(saved.revision, saved.deliveredRevision);
  }
  assert.equal(sends, 2); assert.equal(texts, 0);
});
