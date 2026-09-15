import test from 'node:test';
import assert from 'node:assert/strict';
import { readableMarkdown, resultPages } from '../src/control-plane/result-presentation.js';
import { cardMarkdownEmphasis } from '../src/control-plane/card-markdown-emphasis.js';

test('card labels trim inner emphasis whitespace and separate adjacent prose', () => {
  assert.equal(readableMarkdown('**同步成功及证据范围： **沿用本轮证据\n** 验证： **开发核对\n**限制：**尚未验证'),
    '**同步成功及证据范围：** 沿用本轮证据\n**验证：** 开发核对\n**限制：** 尚未验证');
  assert.equal(readableMarkdown('**normal** text'), '**normal** text');
});
test('code examples and escaped literal markers remain unchanged', () => {
  const source = '```md\n** 原样： **text\n```\n`** 原样 **` and ``** code **``\n\\** literal **';
  assert.equal(cardMarkdownEmphasis(source), source);
  const tilde = '~~~~md\n** 示例 **\n~~~\n** 仍是代码 **\n~~~~';
  assert.equal(cardMarkdownEmphasis(tilde), tilde);
});
test('large emphasis preserves content without leaking split formatting markers', () => {
  const evidence = '证据'.repeat(1600);
  const pages = resultPages(`** ${evidence} **`);
  assert.ok(pages.length > 1);
  assert.equal(pages.join('').replace(/\s/g, ''), evidence);
  assert.ok(pages.every(p => !p.includes('**')));
});
