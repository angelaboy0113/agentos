const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
export function validateToolQuery(e, q) {
  if (q.browser !== undefined && (typeof q.browser !== 'boolean' || e.kind !== 'nacos' || q.mode !== 'investigate')) throw new Error('浏览器只支持已授权的Nacos工具排查');
  if (q.mode !== 'investigate') return false;
  if (q.parameters.length !== 1 || q.parameters[0].name !== 'purpose' || q.parameters[0].type !== 'string') throw new Error('排查必须绑定本次目的');
  if (!Number.isInteger(q.maxCalls) || q.maxCalls < 1 || q.maxCalls > 12) throw new Error('排查工具次数无效');
  if (e.kind === 'nacos' && (!Array.isArray(q.namespaces) || !q.namespaces.length || q.namespaces.length > 20 || q.namespaces.some(x => typeof x !== 'string' || x.length > 128))) throw new Error('需明确 Nacos 命名空间范围');
  if (e.kind === 'mysql' && (!Array.isArray(q.tables) || !q.tables.length || q.tables.some(x => x !== '*' && !ident(x)))) throw new Error('需明确数据库表范围');
  return true;
}
