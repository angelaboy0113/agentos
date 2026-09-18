import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conversationCard } from '../src/control-plane/message-cards.js';
import { conciseSummary, PRIMARY_RESPONSE_LIMIT } from '../src/control-plane/result-presentation.js';

const turn = (response) => ({ id: 'c', status: 'sent', role: 'owner_intake', response });

test('normal analytical replies remain visible on the main card instead of being compressed to 360 characters', () => {
  const response = [
    '先说结论：按整月切换可以显著降低迁移风险，但不会自动解决历史预算和占用的口径差异。',
    '主要影响包括模板需要重做、历史数据继续保留旧层级、报表需要同时处理新旧维度，以及增量更新要避免重复或遗漏。',
    '在没有待分配、调整和调拨单据的前提下，单据迁移风险会下降，但仍要核对预算占用、已审批单据、跨月统计和定时任务。',
    '如果切换日期、目标环境和统计口径尚未确定，可以先分别给出月初切换、月中切换和仅验证 UAT 三种情况下的结论，再补充最终建议。',
  ].join('\n\n').repeat(2);
  assert.ok(Array.from(response).length > 360);
  assert.ok(Array.from(response).length < PRIMARY_RESPONSE_LIMIT);
  assert.equal(conciseSummary(response), response);
  assert.equal(conversationCard(turn(response)).body.elements.some(e => e.tag === 'collapsible_panel'), false);
});

test('only genuinely long replies fold overflow while preserving a substantial primary answer', () => {
  const response = '完整业务判断、影响、前提和风险。'.repeat(200);
  const visible = conciseSummary(response);
  assert.ok(Array.from(visible).length > 800);
  assert.ok(Array.from(visible).length <= PRIMARY_RESPONSE_LIMIT + 30);
  assert.match(visible, /详情含完整证据/);
  assert.equal(conversationCard(turn(response)).body.elements.some(e => e.tag === 'collapsible_panel'), true);
});

test('conversation policy scales detail to the question and gives conditional analysis before clarification', async () => {
  const policy = await readFile(new URL('../config/conversation.md', import.meta.url), 'utf8');
  assert.match(policy, /长度随问题复杂度变化/);
  assert.match(policy, /先说明在不同条件下的结论/);
  assert.doesNotMatch(policy, /通常 2–4 句即可/);
  const schema = JSON.parse(await readFile(new URL('../config/task-result.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.summary.maxLength, 1200);
});
