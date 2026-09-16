import { safeExecutionError } from '../shared/failure-diagnostic.js';
import { createNacosBrowser } from './environment-browser.js';
import { boundedFetch, checkAccountGrants } from './environment-connector.js';
import { databaseEndpoints } from './config-endpoints.js';
const secretName = /password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
const bounded = (x, secrets = []) => { let s = String(x ?? '').slice(0, 500); for (const v of secrets.filter(Boolean)) s = s.split(v).join('[已隐藏]'); return s; };
export function selectStatement(args, tables, q) {
  const { table, columns, filters } = args;
  const known = tables.get(table);
  if (!known || !(q.tables.includes('*') || q.tables.includes(table)) || !Array.isArray(columns) || !columns.length || columns.length > 12 || columns.some(c => !known.includes(c) || !ident(c) || secretName.test(c))) throw new Error('查询表或列超出范围');
  if (!Array.isArray(filters) || !filters.length || filters.length > 6) throw new Error('业务查询必须包含明确筛选条件，不能全表读取');
  const params = [], where = filters.map(f => {
    if (!known.includes(f.column) || !ident(f.column) || secretName.test(f.column) || !['=','>','>=','<','<='].includes(f.op) || !['string','number'].includes(typeof f.value) || String(f.value).length > 200) throw new Error('查询筛选条件无效');
    params.push(f.value); return `\`${f.column}\` ${f.op} ?`;
  }).join(' AND ');
  return { sql: `SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\` WHERE ${where} LIMIT ${q.maxRows + 1}`, params, columns };
}
export async function createEnvironmentTools(e, q, cred, adapters = {}) {
  const secrets = [cred.username, cred.password]; let conn, token, calls = 0, active = true;
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
    { tool: 'schema', args: {}, description: '读取本数据库允许的基础表和普通字段，不读取业务数据' },
    { tool: 'select', args: { table: 'schema返回的表', columns: ['字段'], filters: [{ column: '字段', op: '=', value: '筛选值' }] }, description: `按明确条件读取最多${q.maxRows}行；仅基础表，不允许SQL、函数、联表或写入` }
  ];
  let browser;
  if (q.browser === true && e.kind === 'nacos') { browser = await (adapters.browser ?? createNacosBrowser)(e,q,cred,adapters); spec.push(...browser.spec); }
  const run = async (tool, args = {}) => {
    if (!active || ++calls > q.maxCalls) throw new Error('工具次数已达本次上限');
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
          return { config: args.ref, rows: found.slice(0, q.maxRows), truncated: found.length > q.maxRows, partial: found.unresolved || !found.length, stage: found.length ? '配置已读取，数据库地址已解析' : '配置已读取，未解析出数据库地址', databaseConnection: '未测试；不能把配置业务账号用于数据库连接' };
        }
        const c = await mysql();
        if (tool === 'connection') return { stage: '数据库连接、账号策略和只读事务已验证' };
        if (tool === 'schema') {
          const [rows] = await c.execute({ sql: "SELECT c.TABLE_NAME AS table_name,c.COLUMN_NAME AS column_name FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE' AND c.EXTRA NOT LIKE '%GENERATED%' ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION LIMIT 2001", timeout: q.timeoutMs }, [e.database]);
          tables.clear(); for (const r of rows.slice(0, 2000)) if (ident(r.table_name) && ident(r.column_name) && !secretName.test(r.column_name) && (q.tables.includes('*') || q.tables.includes(r.table_name))) tables.set(r.table_name, [...(tables.get(r.table_name) ?? []), r.column_name]);
          return { tables: Object.fromEntries(tables), truncated: rows.length > 2000 };
        }
        const statement = selectStatement(args, tables, q);
        const [rows] = await c.execute({ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
        return { rows: rows.slice(0, q.maxRows).map(r => Object.fromEntries(statement.columns.map(k => [k, bounded(r[k], secrets)]))), truncated: rows.length > q.maxRows };
      })(), new Promise((_, reject) => { timer = setTimeout(() => { active = false; conn?.destroy(); conn = null; reject(new Error('环境工具超时')); }, q.timeoutMs); })]);
    } catch (error) { throw safeExecutionError(error); }
    finally { clearTimeout(timer); }
  };
  return { spec, run, close: async () => { active = false; token = null; await browser?.close(); if (conn) { try { await conn.rollback(); } finally { conn.destroy(); conn = null; } } } };
}
