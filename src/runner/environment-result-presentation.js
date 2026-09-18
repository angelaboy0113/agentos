import { publicText } from '../control-plane/result-presentation.js';
const sensitive = /password|passwd|secret|token|credential|authorization|username|private.?key/i;
const cell = v => publicText(typeof v === 'object' ? '[结构化值]' : String(v ?? '')).replace(/[\r\n]+/g, ' ').slice(0, 160);
export function presentEnvironmentResult(plan, result, explanation = '') {
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
  const timeout = /^错误码：TIMEOUT\b/m.test(String(result.summary ?? ''));
  const finding = publicText(explanation || result.summary || '当前结果尚未形成业务结论，请查看详情中的证据与缺口。');
  const summary = endpoints && !explanation
    ? [heading, preview ? `连接信息\n${preview}` : '', unique.length > 2 ? `另有 ${unique.length - 2} 条，展开详情查看。` : '', note].filter(Boolean).join('\n\n')
    : [result.partial ? '排查尚未完成，目前不能给出完整结论。' : heading,
      timeout ? '本次进展\n已取得部分查询证据，但后续操作等待超时，排查中断。中间记录不等于问题原因。'
        : `本次发现\n${finding}`,
      timeout ? '尚未确认\n本次超时不能作为用户所报问题的原因；业务原因仍需进一步核实。' : '',
      timeout ? '下一步\n建议从中断的查询继续，缩小范围并核对相关证据；需要其他系统证据时再补充接入。尚未自动重试。' : '',
      '查询记录、技术字段和执行过程见详情。'].filter(Boolean).join('\n\n');
  const details = rows.map((row,i) => `记录 ${i+1}（查询证据，不代表原因）\n\n${Object.entries(row).map(([k,v]) => `- ${cell(k)}：${cell(v)}`).join('\n\n')}`).join('\n\n');
  const metadata = `${plan.tier.toUpperCase()} · ${plan.description}：返回 ${unique.length} 条去重结果${result.truncated ? '（结果受限，非全部数据）' : ''}。读取时间：${result.evidence.readAt}。${note}`;
  return { summary, details, metadata };
}
