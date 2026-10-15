const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
export function validateToolQuery(e, q) {
  if (q.browser !== undefined && (typeof q.browser !== 'boolean' || !['nacos','website'].includes(e.kind) || q.mode !== 'investigate')) throw new Error('浏览器只支持已授权的Nacos工具排查');
  if(q.exportMaxRows!==undefined&&(e.kind!=='mysql'||q.mode!=='investigate'||!Number.isInteger(q.exportMaxRows)||q.exportMaxRows<1||q.exportMaxRows>10000))throw new Error('完整报表行数仅支持MySQL排查的1至10000行');
  if(q.exportTimeoutMs!==undefined&&(!q.exportMaxRows||!Number.isInteger(q.exportTimeoutMs)||q.exportTimeoutMs<1000||q.exportTimeoutMs>60000))throw new Error('完整报表单工具时限必须为1000至60000毫秒');
  if(q.exportDataBudgetBytes!==undefined&&(!q.exportMaxRows||!Number.isInteger(q.exportDataBudgetBytes)||q.exportDataBudgetBytes<1000000||q.exportDataBudgetBytes>256000000))throw new Error('任务数据预算须为1000000至256000000字节，仅由管理员配置');
  if(q.exportSnapshotWindowMs!==undefined&&(!q.exportMaxRows||!Number.isInteger(q.exportSnapshotWindowMs)||q.exportSnapshotWindowMs<60000||q.exportSnapshotWindowMs>3600000))throw new Error('报表取数窗口必须为60000至3600000毫秒，仅由管理员按数据变化频率配置');
  if (q.mode !== 'investigate') return false;
  if (q.parameters.length !== 1 || q.parameters[0].name !== 'purpose' || q.parameters[0].type !== 'string') throw new Error('排查必须绑定本次目的');
  // Legacy maxCalls is accepted for compatibility, but no longer controls investigation.
  if (q.maxCalls !== undefined && (!Number.isInteger(q.maxCalls) || q.maxCalls < 1)) throw new Error('排查工具次数无效');
  if (e.kind === 'nacos' && (!Array.isArray(q.namespaces) || !q.namespaces.length || q.namespaces.length > 20 || q.namespaces.some(x => typeof x !== 'string' || x.length > 128))) throw new Error('需明确 Nacos 命名空间范围');
  if (e.kind === 'mysql' && (!Array.isArray(q.tables) || !q.tables.length || q.tables.some(x => x !== '*' && !ident(x)))) throw new Error('需明确数据库表范围');
  return true;
}
