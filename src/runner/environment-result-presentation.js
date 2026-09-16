import { publicText } from '../control-plane/result-presentation.js';
const sensitive = /password|passwd|secret|token|credential|authorization|username|private.?key/i;
const cell = v => publicText(typeof v === 'object' ? '[结构化值]' : String(v ?? '')).replace(/[\r\n]+/g, ' ').slice(0, 160);
export function presentEnvironmentResult(plan, result) {
  const rows = [...new Map((result.rows ?? []).map(row => {
    const safe = Object.fromEntries(Object.entries(row).filter(([key]) => !sensitive.test(key)));
    return [JSON.stringify(Object.entries(safe).sort(([a], [b]) => a.localeCompare(b))), safe];
  })).values()];
  const endpoints = rows.length > 0 && rows.every(r => r.host && r.port && r.database);
  const unique = endpoints ? [...new Map(rows.map(r => [`${r.host}:${r.port}/${r.database}`, r])).values()] : rows;
  const heading = result.partial ? '部分结果，排查尚未完成。' : unique.length ? `${plan.tier.toUpperCase()} · 查询结果` : '本次未返回记录，尚不能据此确认目标信息。';
  const line = (row, i) => endpoints
    ? `${i + 1}. 主机/IP：${cell(row.host)}\n端口：${cell(row.port)} · 库名：${cell(row.database)}`
    : `${i + 1}. ${Object.entries(row).slice(0, 4).map(([k,v]) => `${cell(k)}：${cell(v)}`).join('\n')}`;
  const preview = unique.slice(0, 2).map(line).join('\n\n');
  const note = plan.kind === 'mysql' ? (result.note ?? '') : (result.note ?? '以上来自配置读取，未验证数据库连接。');
  const finding = publicText(result.summary ?? '').slice(0, 160);
  const summary = [heading, preview ? `关键数据\n${preview}` : '', result.partial ? `待核实\n${finding || '现有证据不足以完成排查，完整缺口见详情。'}` : finding, unique.length > 2 ? `另有 ${unique.length - 2} 条，展开详情查看。` : '', note].filter(Boolean).join('\n\n');
  const details = rows.map((row,i) => `记录 ${i+1}\n${Object.entries(row).map(([k,v]) => `${cell(k)}：${cell(v)}`).join('\n')}`).join('\n\n');
  const metadata = `${plan.tier.toUpperCase()} · ${plan.description}：返回 ${unique.length} 条去重结果${result.truncated ? '（结果受限，非全部数据）' : ''}。读取时间：${result.evidence.readAt}。${note}`;
  return { summary, details, metadata };
}
