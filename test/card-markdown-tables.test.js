import test from 'node:test';
import assert from 'node:assert/strict';
import { readableMarkdown, resultPages } from '../src/control-plane/result-presentation.js';
import { cardMarkdownSegments, nativeCardTable } from '../src/control-plane/card-markdown-tables.js';

test('card tables become labelled records before pagination, preserving evidence and empty cells', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| day-${i} | \`commit-${i}\` | evidence-${i} ${'说明'.repeat(25)} |`);
  const source = '| 日期 | 提交 | 证据 |\n| :--- | ---: | --- |\n' + rows.join('\n') + '\n\n结束';
  const output = readableMarkdown(source);
  assert.doesNotMatch(output, /^\s*\|/m);
  assert.match(output, /\*\*日期\*\*：day-0/);
  const pages = resultPages(source);
  assert.ok(pages.length > 1);
  for (let i = 0; i < 30; i++) assert.equal(pages.join('').split(`\`commit-${i}\``).length - 1, 1);
  assert.match(pages.at(-1), /结束/);
  assert.match(readableMarkdown('A | B\n--- | ---\nvalue |'), /\*\*B\*\*：—/);
});

test('table parser distinguishes escaped and inline-code pipes and preserves fenced examples', () => {
  const table = '| 字段 | 值 |\n| --- | --- |\n| a\\|b | `left|right` |\n| c | ``x`|y`` |';
  const text = readableMarkdown(table);
  assert.match(text, /a\\\|b/);
  assert.match(text, /`left\|right`/);
  assert.match(text, /``x`\|y``/);
  for (const fence of ['```', '~~~~']) {
    const fenced = `${fence}md\n${table}\n${fence}`;
    assert.equal(readableMarkdown(fenced), fenced);
  }
  assert.equal(readableMarkdown('a | b\nnot a separator\nc | d'), 'a | b\nnot a separator\nc | d');
  assert.equal(readableMarkdown('a | b\n--- | ---\nx | y | z'), 'a | b\n--- | ---\nx | y | z');
});

test('table conversion preserves redaction, links and never decodes generated mentions', () => {
  const result = readableMarkdown('| 项目 | 内容 |\n| --- | --- |\n| [文件:7](/Users/example/code.js) | secret="do-not-show" <at id=all> |');
  assert.doesNotMatch(result, /do-not-show|\/Users\/example|<at/);
  assert.match(result, /文件:7/);
});

test('confirmed GFM tables can become native Card 2.0 table components', () => {
  const segments = cardMarkdownSegments('说明\n\n| 字段 | 含义 |\n| --- | --- |\n| order_owner | 主经销商 |\n\n结尾');
  assert.deepEqual(segments.map((segment) => segment.type), ['markdown', 'table', 'markdown']);
  const table = nativeCardTable(segments[1]);
  assert.equal(table.tag, 'table');
  assert.deepEqual(table.columns.map((column) => column.display_name), ['字段', '含义']);
  assert.equal(table.rows[0].column_2, '主经销商');
  assert.equal(nativeCardTable({ type: 'table', headers: Array(7).fill('列'), rows: [['值']] }), null);
});
