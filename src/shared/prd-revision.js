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

const plain = /[\[\]<>*_`~\\]/;
const highlight = text => '<span background-color="light-yellow">' +
  text.replaceAll('&', '&amp;') + '</span>';

function inlineChange(before, after) {
  if (before === after || !after.trim()) return after;
  const [start, end] = [after.match(/^\s*/)[0], after.match(/\s*$/)[0]];
  const next = after.trim(), old = before.trim();
  if (plain.test(next)) {
    const formatted = /^(\*\*|__)(.+)\1$/.exec(next);
    if (formatted && !plain.test(formatted[2])) {
      return start + formatted[1] + inlineChange(old.replace(/^(\*\*|__)(.*)\1$/, '$2'), formatted[2]) + formatted[1] + end;
    }
    // Keep links, code, and existing emphasis syntactically intact; compare
    // the text before and after them when the markup did not move.
    const split = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__)/;
    const chunks = next.split(split), prior = old.split(split);
    if (chunks.length > 1 && chunks.length === prior.length && chunks.every((text,i)=>i%2===0||text===prior[i])) {
      return start + chunks.map((text,i)=>i%2?text:inlineChange(prior[i],text)).join('') + end;
    }
    return after;
  }
  let left = 0, right = 0;
  const a = [...old], b = [...next];
  while (left < a.length && left < b.length && a[left] === b[left]) left++;
  while (right < a.length - left && right < b.length - left && a.at(-1 - right) === b.at(-1 - right)) right++;
  if (left + right === b.length) return start + highlight(next) + end;
  return start + b.slice(0,left).join('') + highlight(b.slice(left,b.length-right).join('')) + b.slice(b.length-right).join('') + end;
}

export function prdHighlightChanges(baseline, markdown) {
  if (!baseline) return markdown;
  const prior = new Map(), seen = new Map();
  const lines = input => {
    let section = '开篇', heading = false, code = false;
    const headings = [];
    return revisionBody(input).split(/\r?\n/).map(line => {
      if (/^\s*(?:`{3,}|~{3,})/.test(line)) { code = !code; return { line }; }
      if (code || !line.trim() || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return { line };
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) {
        headings.length = h[1].length;
        headings[h[1].length-1] = !heading && h[1].length === 1 ? '' : h[2];
        heading = true;
        section = headings.filter(Boolean).join('/') || '标题';
      }
      const kind = h ? 'heading' : /^\s*\|.+\|\s*$/.test(line) ? 'table' : 'text';
      return { line, section, kind };
    });
  };
  for (const item of lines(baseline.markdown)) {
    if (!item.kind) continue;
    const key = JSON.stringify([item.section,item.kind]);
    if (!prior.has(key)) prior.set(key, []);
    prior.get(key).push(item.line);
  }
  return lines(markdown).map(({line,section,kind})=>{
    if (!kind) return line;
    const key = JSON.stringify([section,kind]), index = seen.get(key) ?? 0;
    seen.set(key,index+1);
    const previous = prior.get(key) ?? [];
    if (previous.includes(line)) return line;
    const old = previous[index] ?? '';
    if (kind === 'table' && !/\\\|/.test(line)) {
      const oldCells = old.split('|');
      return line.split('|').map((cell,i)=>inlineChange(oldCells[i]??'',cell)).join('|');
    }
    const syntax = /^(\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)?)(.*)$/.exec(line);
    const oldText = old.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)?/,'');
    return syntax[1] + inlineChange(oldText,syntax[2]);
  }).join('\n');
}
