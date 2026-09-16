import { createHash } from 'node:crypto';
import { safeExecutionError } from '../shared/failure-diagnostic.js';
import { createNacosBrowser } from './environment-browser.js';
import { boundedFetch, checkAccountGrants } from './environment-connector.js';
import { databaseEndpoints } from './config-endpoints.js';
const secretName = /password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
const bounded = (x, secrets = []) => { let s = String(x ?? '').slice(0, 500); for (const v of secrets.filter(Boolean)) s = s.split(v).join('[已隐藏]'); return s; };
export class QueryInputError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
}
export function selectStatement(args, tables, q) {
  const { table, columns, filters } = args;
  const known = tables.get(table);
  if (!ident(table) || !(q.tables.includes('*') || q.tables.includes(table))) throw new Error('查询表超出范围');
  if (!known) throw new QueryInputError('SCHEMA_REQUIRED', '目标表尚未读取结构；先调用schema并指定table，再选择实际返回的字段。');
  if (!Array.isArray(columns) || !columns.length) throw new QueryInputError('QUERY_INPUT', 'columns必须是非空字段数组。');
  if (columns.length > 12) throw new QueryInputError('COLUMN_LIMIT', '一次最多选择12个字段；只选择与问题相关的字段，必要时分次读取。');
  if (columns.some(c => typeof c === 'string' && secretName.test(c))) throw new Error('查询列超出范围');
  if (columns.some(c => !ident(c))) throw new QueryInputError('QUERY_INPUT', 'columns仅接受schema返回的普通字段名，不能使用*、函数或表达式。');
  if (columns.some(c => !known.includes(c))) throw new QueryInputError('SCHEMA_FIELDS', '字段未在已读取结构中；重新读取目标表schema或继续分页，仅使用返回的字段。');
  if (!Array.isArray(filters) || !filters.length || filters.length > 6) throw new QueryInputError('QUERY_INPUT', 'filters必须包含1至6个明确筛选条件，不允许全表读取。');
  const params = [], where = filters.map(f => {
    if (!f || !ident(f.column) || secretName.test(f.column)) throw new Error('查询筛选列超出范围');
    if (!known.includes(f.column)) throw new QueryInputError('SCHEMA_FIELDS', '筛选字段未在已读取结构中；先读取目标表schema并使用实际字段。');
    if (!['=','>','>=','<','<='].includes(f.op) || !['string','number'].includes(typeof f.value) || (typeof f.value === 'number' && !Number.isFinite(f.value)) || String(f.value).length > 200) throw new QueryInputError('QUERY_INPUT', '筛选仅支持=、>、>=、<、<=；value为不超过200字符的字符串或有限数字。');
    params.push(f.value); return `\`${f.column}\` ${f.op} ?`;
  }).join(' AND ');
  return { sql: `SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\` WHERE ${where} LIMIT ${q.maxRows + 1}`, params, columns };
}
export async function createEnvironmentTools(e, q, cred, adapters = {}) {
  const secrets = [cred.username, cred.password]; let conn, token, active = true;
  const configs = new Map(), tables = new Map();
  const request = adapters.fetch ?? boundedFetch;
  async function nacos(api, params = {}, login = false) {
    if (!active) throw new Error('工具执行已结束');
    const url = new URL(e.baseUrl.replace(/\/$/, '') + api);
    let options = { signal: AbortSignal.timeout(q.timeoutMs) };
    if (login) options = { ...options, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: cred.username, password: cred.password }) };
    else { if (!token) throw new Error('先执行 connection 工具登录'); url.search = new URLSearchParams({ ...params, accessToken: token }).toString(); }
    return request(url, options);
  }
  async function mysql() {
    if (!conn) {
      const driver = adapters.mysql ?? await import('mysql2/promise');
      conn = await driver.createConnection({ host: e.host, port: e.port, database: e.database, user: cred.username, password: cred.password, connectTimeout: q.timeoutMs, multipleStatements: false, enableCleartextPlugin: false, ...(e.tls ? { ssl: { rejectUnauthorized: true } } : {}) });
      if (!active) { conn.destroy(); conn = null; throw new Error('连接已超时'); }
      try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER'); checkAccountGrants(e, g); await conn.query(`SET SESSION MAX_EXECUTION_TIME=${q.timeoutMs}`); await conn.query('START TRANSACTION READ ONLY'); }
      catch (error) { conn.destroy(); conn = null; throw error; }
    }
    return conn;
  }
  const spec = e.kind === 'nacos' ? [
    { tool: 'connection', args: {}, description: '测试固定 Nacos 入口的 HTTP 登录，凭据留在本机' },
    { tool: 'discover', args: {}, description: '列出批准的命名空间内最多100条配置的引用和名称，不返回正文' },
    { tool: 'read_config', args: { ref: '从discover返回的ref' }, description: '读取一个已发现配置并解析同文件变量，仅返回数据库端点与解析状态' }
  ] : [
    { tool: 'connection', args: {}, description: '测试数据库连接、只读账号授权与只读事务' },
    { tool: 'tables', args: {cursor:'可选：nextCursor，默认0'}, description:'分页列出允许的基础表名称，先定位目标表再用schema读取列' },
    { tool: 'schema', args: { table: '可选：限定基础表名', cursor: '可选：上次返回的nextCursor，默认0' }, description: '读取本数据库允许的基础表和普通字段，不读取业务数据' },
    { tool: 'select', args: { table: 'schema返回的表', columns: ['字段'], filters: [{ column: '字段', op: '=', value: '筛选值' }] }, description: `按明确条件读取最多${q.maxRows}行；columns最多12个已读取字段，filters必须有1至6个条件且op仅支持=、>、>=、<、<=；仅基础表，不允许SQL、函数、联表或写入` }
  ];
  let browser;
  if (q.browser === true && e.kind === 'nacos') { browser = await (adapters.browser ?? createNacosBrowser)(e,q,cred,adapters); spec.push(...browser.spec); }
  const run = async (tool, args = {}) => {
    if (!active) throw new Error('工具执行已结束');
    if (!spec.some(x => x.tool === tool) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('不支持的工具或参数');
    if (tool.startsWith('browser_')) { if (!browser) throw new Error('当前范围未启用浏览器'); return browser.run(tool,args); }
    // A single operation cannot keep a connection alive beyond its declared timeout.
    let timer;
    try {
      return await Promise.race([(async () => {
        if (e.kind === 'nacos') {
          if (tool === 'connection') { const v = JSON.parse(await nacos('/v1/auth/login', {}, true)); if (typeof v.accessToken !== 'string' || !v.accessToken) throw new Error('Nacos 认证未成功'); token = v.accessToken; return { stage: 'Nacos 网络与登录成功', databaseConnection: '尚未测试，需要独立只读数据库入口' }; }
          if (tool === 'discover') {
            configs.clear(); let truncated = false;
            for (const namespace of q.namespaces) {
              const v = JSON.parse(await nacos('/v2/cs/history/configs', { namespaceId: namespace }));
              if (v.code !== 0 || !Array.isArray(v.data)) throw new Error('配置发现接口不支持或无权限');
              for (const x of v.data) { if (configs.size >= 100) { truncated = true; break; } if (typeof x.dataId !== 'string' || typeof x.group !== 'string') continue;
                configs.set(`config-${configs.size + 1}`, { namespace, dataId: x.dataId, group: x.group }); }
            }
            return { configs: [...configs].map(([ref, x]) => ({ ref, namespace: bounded(x.namespace, secrets), dataId: bounded(x.dataId, secrets), group: bounded(x.group, secrets) })), truncated };
          }
          const x = configs.get(args.ref); if (!x) throw new Error('仅可读取本次发现的配置引用');
          const content = await nacos('/v1/cs/configs', { tenant: x.namespace, group: x.group, dataId: x.dataId });
          const found = databaseEndpoints(content);
          return { config: args.ref, rows: found.slice(0, q.maxRows).map(row=>({...row,connectionSource:{...x,contentHash:createHash('sha256').update(content).digest('hex')}})), truncated: found.length > q.maxRows, partial: found.unresolved || !found.length, stage: found.length ? '配置已读取，数据库地址已解析' : '配置已读取，未解析出数据库地址', databaseConnection: '未测试；管理员确认后可在本机提取凭据并通过受控只读模式验证' };
        }
        const c = await mysql();
        if (tool === 'connection') return { stage: '数据库连接、账号策略和只读事务已验证' };
        if (tool === 'tables') {
          const offset=args.cursor===undefined?0:Number(args.cursor);
          if(!Number.isInteger(offset)||offset<0||offset>100000)throw new Error('结构分页参数无效');
          const [rows]=await c.execute({sql:`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME LIMIT 101 OFFSET ${offset}`,timeout:q.timeoutMs},[e.database]);
          return {tableNames:rows.slice(0,100).map(r=>r.table_name).filter(t=>ident(t)&&(q.tables.includes('*')||q.tables.includes(t))),truncated:rows.length>100,nextCursor:rows.length>100?offset+100:null};
        }
        if (tool === 'schema') {
          if(args.table !== undefined && (!ident(args.table) || !(q.tables.includes('*') || q.tables.includes(args.table)))) throw new Error('查询表超出范围');
          const offset = args.cursor === undefined ? 0 : Number(args.cursor);
          if(!Number.isInteger(offset) || offset<0 || offset>100000) throw new Error('结构分页参数无效');
          const [rows] = await c.execute({ sql: "SELECT c.TABLE_NAME AS table_name,c.COLUMN_NAME AS column_name FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE' AND c.EXTRA NOT LIKE '%GENERATED%'" + (args.table ? " AND c.TABLE_NAME=?" : "") + ` ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION LIMIT 101 OFFSET ${offset}`, timeout: q.timeoutMs }, args.table ? [e.database,args.table] : [e.database]);
          const visible = new Map();
          for (const r of rows.slice(0,100)) if (ident(r.table_name) && ident(r.column_name) && !secretName.test(r.column_name) && (q.tables.includes('*') || q.tables.includes(r.table_name))) {
            visible.set(r.table_name,[...(visible.get(r.table_name)??[]),r.column_name]);
            tables.set(r.table_name,[...new Set([...(tables.get(r.table_name)??[]),r.column_name])]);
          }
          const result = {tables:Object.fromEntries(visible),truncated:rows.length>100,nextCursor:rows.length>100?offset+100:null};
          if(result.truncated) result.note='仅当前页表结构；可用schema的nextCursor继续，或指定table读取目标表。';
          return result;
        }
        const statement = selectStatement(args, tables, q);
        const [rows] = await c.execute({ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
        return { table: args.table, rows: rows.slice(0, q.maxRows).map(r => Object.fromEntries(statement.columns.map(k => [k, bounded(r[k], secrets)]))), truncated: rows.length > q.maxRows };
      })(), new Promise((_, reject) => { timer = setTimeout(() => { active = false; conn?.destroy(); conn = null; reject(new Error('环境工具超时')); }, q.timeoutMs); })]);
    } catch (error) { if (error instanceof QueryInputError) throw error; throw safeExecutionError(error); }
    finally { clearTimeout(timer); }
  };
  return { spec, run, close: async () => { active = false; token = null; await browser?.close(); if (conn) { try { await conn.rollback(); } finally { conn.destroy(); conn = null; } } } };
}
