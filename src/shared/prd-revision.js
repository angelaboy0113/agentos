import { reportFile } from './report-files.js';
import { prdIntentDigest } from './prd-workspace.js';

export function prdDeliveryLink(delivery) {
  if (!delivery?.sentAt || !Number.isSafeInteger(delivery.revision) || delivery.revision < 1) return null;
  try {
    const url = new URL(delivery.url);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname)
      && /^\/docx\/[A-Za-z0-9_-]+$/.test(url.pathname)) return url.href;
  } catch {}
  return null;
}

export function previousPrdDelivery(question, revision) {
  return [question.prd?.delivery, ...Object.values(question.prd?.deliveryHistory ?? {})]
    .filter(d => prdDeliveryLink(d) && d.revision < revision).sort((a, b) => b.revision - a.revision)[0];
}

export async function readPrdRevisionBaseline(dataDir, job, previous) {
  if (!prdDeliveryLink(previous) || previous.revision >= job.prd.revision) return null;
  const generation = previous.artifacts?.generation ?? previous.revision;
  const files = (job.reportFiles ?? []).filter(f => f.questionGeneration === generation);
  for (const markdown of files.filter(f => f.format === 'md')) {
    for (const prototype of files.filter(f => f.format === 'png')) {
      if (previous.artifacts && (markdown.id !== previous.artifacts.markdownId || prototype.id !== previous.artifacts.prototypeId)) continue;
      if (previous.digest !== prdIntentDigest([job.questionId, job.chatId, previous.revision, generation, markdown.sha256, prototype.sha256])) continue;
      const { content } = await reportFile(dataDir, job.id, markdown);
      return { markdown: content.toString('utf8'), prototypeHash: prototype.sha256 };
    }
  }
  return null;
}

export function revisionBody(markdown) {
  return markdown.replace(/!\[[^\]\r\n]*\]\(data:image\/[\w+.-]+;base64,[A-Za-z0-9+/]+={0,2}\)/gi, '').trim();
}

function sections(markdown) {
  const collected = new Map();
  const headings = [];
  let firstTitle = true;
  let section = { label: '开篇', lines: [] };
  collected.set('开篇', section);
  for (const line of revisionBody(markdown).split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      headings.length = heading[1].length;
      const isTitle = firstTitle && heading[1].length === 1;
      if (isTitle) firstTitle = false;
      headings[heading[1].length - 1] = isTitle ? '' : heading[2].trim();
      const label = isTitle ? '文档标题' : headings.filter(Boolean).join(' / ');
      let key = label;
      for (let occurrence = 2; collected.has(key); occurrence++) key = label + ' (' + occurrence + ')';
      section = { label: key, lines: isTitle ? [heading[2].trim()] : [] };
      collected.set(key, section);
    } else if (line.trim() && !/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) {
      section.lines.push(line.trim().replace(/\s+/g, ' '));
    }
  }
  return collected;
}

function excerpt(lines) {
  const text = lines.join('；').replace(/[|]/g, '／').replace(/[<>\[\]`*_]/g, '').replace(/\\/g, '／');
  const chars = Array.from(text);
  return chars.length > 180 ? chars.slice(0, 179).join('') + '…' : text || '—';
}

export function prdRevisionSection(previous, baseline, markdown, prototypeHash) {
  const url = prdDeliveryLink(previous);
  if (!url) return '';
  const heading = '## 本次变更\n\n对照 [上一版 v0.' + previous.revision + '](' + url + ')。\n\n';
  if (!baseline) return heading + '上一版交付快照已不可读，请打开上方版本核对内容。\n\n';
  const old = sections(baseline.markdown);
  const next = sections(markdown);
  const rows = [];
  for (const key of new Set([...next.keys(), ...old.keys()])) {
    const before = old.get(key)?.lines ?? [], after = next.get(key)?.lines ?? [];
    if (old.has(key) === next.has(key) && JSON.stringify(before) === JSON.stringify(after)) continue;
    const removed = before.filter(line => !after.includes(line)), added = after.filter(line => !before.includes(line));
    rows.push([excerpt([key]), !old.has(key) ? '新增' : !next.has(key) ? '删除' : '修改',
      excerpt(removed.length || added.length ? removed : before), excerpt(removed.length || added.length ? added : after)]);
  }
  if (baseline.prototypeHash !== prototypeHash) rows.push(['原型图', '更新', '上一版原型', '当前版原型见文末']);
  if (!rows.length) return heading + '本轮交付内容与上一版快照一致。\n\n';
  return heading + '| 位置 | 变化 | 上一版 | 本版 |\n|---|---|---|---|\n'
    + rows.map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
}
