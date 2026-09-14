// Public projection only. Never relay reasoning, command arguments, output or tool input.
export function commandLabel(command) {
  const text = String(command ?? '').trim();
  const safe = /^(?:git (?:status(?: --short)?|diff(?: --stat| --numstat| --check)?)|(?:npm|yarn|pnpm) (?:test|run (?:test|check|build|lint)|build|lint))$/;
  if (safe.test(text)) return text;
  if (/\b(?:rg|grep|Select-String)\b/i.test(text)) return '搜索代码（参数隐藏）';
  if (/\b(?:Get-Content|cat|sed|head|tail|type)\b/i.test(text)) return '读取文件（参数隐藏）';
  if (/\bgit\b/i.test(text)) return '运行 Git 命令（参数隐藏）';
  return '运行命令（参数隐藏）';
}

export class ExecutionActivity {
  constructor() { this.items = new Map(); this.total = 0; this.completed = 0; this.recent = []; }
  accept(event) {
    if (!['item.started', 'item.completed'].includes(event.type)) return null;
    const item = event.item;
    const labels = { command_execution: commandLabel(item?.command), file_change: '修改文件',
      mcp_tool_call: '调用扩展工具', web_search: '检索资料' };
    if (!item?.id || !Object.hasOwn(labels, item.type)) return null;
    const previous = this.items.get(item.id);
    if (previous?.done) return null;
    if (!previous) this.total++;
    const done = event.type === 'item.completed';
    const entry = { label: labels[item.type], done,
      failed: done && (item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)) };
    this.items.set(item.id, entry);
    if (done) { this.completed++; this.recent = [...this.recent, entry].slice(-3); }
    return this.snapshot();
  }
  snapshot() {
    const active = [...this.items.values()].filter((item) => !item.done);
    return { total: this.total, completed: this.completed, activeCount: active.length,
      current: active.at(-1)?.label ?? '正在处理后续步骤', recent: this.recent };
  }
}
