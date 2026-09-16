import { createHash } from 'node:crypto';
import { cardMarkdownEmphasis } from './card-markdown-emphasis.js';
import { cardMarkdownTables } from './card-markdown-tables.js';

const clip = (text, size) => Array.from(text).slice(0, size).join('');
export function publicText(text) {
  // Decode legacy escaping before redaction, then escape markup exactly once.
  return String(text ?? '').replace(/&amp;/g, '&')
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (raw, hex, dec) => {
      const n = parseInt(hex ?? dec, hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
    }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, '[密钥已隐藏]')
    .replace(/\b(?:Bearer\s+|sk-)[\w.+\-/=]+/gi, '[凭据已隐藏]')
    .replace(/((?:password|passwd|secret|access[_-]?token|api[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/&/g, '&amp;').replace(/</g, '&#60;').replace(/>/g, '&#62;');
}

export function readableMarkdown(text) {
  return cardMarkdownEmphasis(cardMarkdownTables(publicText(text).replace(/&#60;/g, '＜').replace(/&#62;/g, '＞')
    .replace(/\[([^\]\n]+)\]\((?!https?:\/\/)[^\n)]*\)/gi, '$1')
    .replace(/(^|[\s`(])\/?[a-z]:[\\/][^\s`<>）)]*/gi, (_, prefix) => `${prefix}[本机路径]`)
    .replace(/(^|[\s`(])\/(?:Users|home)\/[^\s`<>）)]*/g, (_, prefix) => `${prefix}[本机路径]`)
    .replace(/^\s*\[(?:READY|NEEDS_CLARIFICATION|BLOCKED)\]\s*/i, '')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**'))).trim();
}

export function conciseSummary(text) {
  const cleaned = readableMarkdown(text).replace(/```[\s\S]*?```/g, '[代码示例见详情]')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/[*`]/g, '').trim();
  if (Array.from(cleaned).length <= 360) return cleaned;
  const prefix = clip(cleaned, 330);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('\n'));
  return `${boundary > 120 ? prefix.slice(0, boundary + 1) : prefix + '…'}\n详情含完整证据与未验证事项。`;
}

// Split compact numbered prose for narrow message cards without changing its claims.
export function summaryParagraphs(text) {
  return String(text ?? '').replace(/([^\n])\s+([1-9][)）])\s*/g, '$1\n\n$2 ')
    .split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

// Small pages bound card bytes. Preserve paragraphs and balance code fences on every page.
export function resultPages(text) {
  const source = readableMarkdown(text);
  if (!source) return [];
  const pages = [];
  let page = '', fence = '';
  const flush = () => {
    if (page.trim()) pages.push(page + (fence ? '\n```' : ''));
    page = fence ? `${fence}\n` : '';
  };
  for (const line of source.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (page.length > 1300) flush();
      fence = fence ? '' : `\`\`\`${marker[2].trim()}`;
      page += `${fence || '```'}\n`;
      continue;
    }
    const points = Array.from(line);
    const chunks = points.length ? Array.from({ length: Math.ceil(points.length / 1300) }, (_, i) => points.slice(i * 1300, (i + 1) * 1300).join('')) : [''];
    for (const chunk of chunks) {
      if (page.length + chunk.length > 1800) flush();
      page += `${chunk}\n`;
    }
  }
  flush();
  return pages;
}

export const detailVersion = (pages) => createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 16);
export function resultPanel(pages, index = 0, expanded = false) {
  const version = detailVersion(pages);
  const elements = [{ tag: 'markdown', content: pages[index], text_size: 'normal' }];
  if (pages.length > 1) {
    elements.push({ tag: 'column_set', flex_mode: 'none', columns: [-1, 1].map((direction) => ({
      tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', type: direction === 1 ? 'primary_filled' : 'default', width: 'fill',
        disabled: index + direction < 0 || index + direction >= pages.length,
        text: { tag: 'plain_text', content: direction === 1 ? '下一页详情' : '上一页详情' },
        behaviors: [{ type: 'callback', value: { action: 'result_page', page: index + direction, version } }],
      }],
    })) });
  }
  return { tag: 'collapsible_panel', element_id: 'result_details', expanded, padding: '12px',
    header: { title: { tag: 'plain_text', content: `查看详细结果与证据 · ${index + 1}/${pages.length}` } }, elements };
}

export function withResultPage(card, pages, index = 0, expanded = false) {
  const copy = structuredClone(card);
  const elements = copy.body.elements.filter((item) => item.element_id !== 'result_details');
  if (pages.length) elements.push(resultPanel(pages, index, expanded));
  copy.body.elements = elements;
  return copy;
}
