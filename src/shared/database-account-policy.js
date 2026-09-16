export const CONNECTION_SQL = 'SELECT DATABASE() AS database_name, CURRENT_TIMESTAMP() AS checked_at';
export function validateAccountPolicy(e) {
 if (e.accountPolicy === undefined) return;
 if (e.kind !== 'mysql' || !['strict-readonly','business-readonly'].includes(e.accountPolicy)) throw new Error('数据库账号策略无效');
 if(e.accountPolicy==='business-readonly') {
  const a=e.businessAccountAuthorization;
  if(!a || !Number.isFinite(Date.parse(a.confirmedAt)) || !Object.values(e.ownerOpenIdsByProfile ?? {}).some(ids=>ids.includes(a.approverId))) throw new Error('业务账号模式需要本机管理员明确确认');
  for(const q of Object.values(e.queries ?? {})) if(q.mode!=='investigate' && q.sql!==CONNECTION_SQL) throw new Error('业务账号模式仅允许连接检查和受控基础表工具，不允许自定义SQL模板');
 }
}
export function accountMode(e) {validateAccountPolicy(e);return e.accountPolicy==='business-readonly'?'business-readonly':'strict-readonly';}
