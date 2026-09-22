import { accountMode } from '../shared/database-account-policy.js';
import { safeExecutionError } from '../shared/failure-diagnostic.js';
import { databaseEndpoints } from './config-endpoints.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadEnvironments, verifyApprovedPlan, fingerprint } from '../shared/environment-access.js';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../../scripts/keychain-credential.py', import.meta.url));
export async function credential(ref) {
  try { const { stdout } = await exec('python3', [helper, 'get', ref], { timeout: 10000, maxBuffer: 16000 }); return JSON.parse(stdout); }
  catch { throw new Error('本机凭据不可读取；请在 Mac 本机完成安全录入或解锁钥匙串'); }
}
const clean = (value, secrets = []) => {
  let s = String(value ?? '').slice(0, 500);
  for (const secret of secrets.filter((x) => typeof x === 'string' && x.length)) s = s.split(secret).join('[已隐藏]');
  return s.replace(/(?:password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[敏感字段已隐藏]').replace(/[\x00-\x08\x0b-\x1f]/g, '');
};
export function assertReadOnlyGrants(rows) {
  if (!rows.length) throw new Error('无法核验数据库只读账号权限');
  for (const row of rows) {
    const text = String(Object.values(row)[0]);
    const m = /^GRANT (.+) ON /i.exec(text);
    if (!m || /WITH GRANT OPTION/i.test(text) || m[1].split(',').some((p) => !['USAGE', 'SELECT', 'SHOW VIEW'].includes(p.trim().toUpperCase()))) throw new Error('数据库账号含写权限、角色授权或不可核验权限；拒绝查询');
  }
}
export function checkAccountGrants(e, rows) {
  const mode = accountMode(e);
  if(mode === 'strict-readonly') assertReadOnlyGrants(rows);
  else if(!Array.isArray(rows) || !rows.length || rows.some(r=>!/^GRANT /i.test(String(Object.values(r)[0])))) throw new Error('无法核验业务账号权限信息');
}
export async function mysqlRead(e, q, parameters, cred, adapters = {}) {
  const mysql = adapters.mysql ?? await import('mysql2/promise');
  let connection, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connection?.destroy(); }, q.timeoutMs);
  try {
    connection = await mysql.createConnection({ host: e.host, port: e.port, database: e.database, user: cred.username, password: cred.password,
      connectTimeout: q.timeoutMs, multipleStatements: false, enableCleartextPlugin: false,
      supportBigNumbers: true, bigNumberStrings: true,
      ...(e.tls ? { ssl: { rejectUnauthorized: true } } : {}) });
    if (timedOut) throw new Error('timeout');
    const [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER'); checkAccountGrants(e, grants);
    await connection.query(`SET SESSION MAX_EXECUTION_TIME=${q.timeoutMs}`);
    await connection.query('START TRANSACTION READ ONLY');
    const [rows] = await connection.execute({ sql: `SELECT * FROM (${q.sql}) AS agentos_read_scope LIMIT ${q.maxRows + 1}`, timeout: q.timeoutMs }, parameters);
    return { truncated: rows.length > q.maxRows, rows: rows.slice(0, q.maxRows).map((row) => Object.fromEntries(q.outputColumns.map((key) => [key, clean(row[key], [cred.password, cred.username])])) ) };
  } finally { clearTimeout(timer); if (connection) { try { await connection.rollback(); } finally { connection.destroy(); } } }
}
export async function boundedFetch(url, options, maxBytes = 1024 * 1024) {
  const response = await fetch(url, { ...options, redirect: 'error' });
  if (!response.ok) throw new Error(`环境接口未成功响应 HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body?.cancel(); throw new Error('环境响应超过限制'); }
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > maxBytes) throw new Error('环境响应超过限制'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
export { databaseEndpoints } from './config-endpoints.js';
export async function nacosRead(e, q, cred, adapters = {}) {
  const request = adapters.fetch ?? boundedFetch, base = e.baseUrl.replace(/\/$/, '');
  const signal = AbortSignal.timeout(q.timeoutMs);
  const login = JSON.parse(await request(`${base}/v1/auth/login`, { method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: cred.username, password: cred.password }) }, 16000));
  if (!login.accessToken || typeof login.accessToken !== 'string') throw new Error('环境认证未成功');
  const url = new URL(`${base}/v1/cs/configs`); url.search = new URLSearchParams({ dataId: q.dataId, group: q.group, tenant: q.namespace, accessToken: login.accessToken }).toString();
  const content = await request(url, { signal });
  const endpoints = databaseEndpoints(content);
  return { rows: endpoints.slice(0, q.maxRows), truncated: endpoints.length > q.maxRows, partial: !endpoints.length || endpoints.unresolved,
    steps: ['Nacos 登录成功', '指定配置读取成功', endpoints.length ? '数据库地址已解析' : '未解析出数据库地址'],
    note: `${endpoints.unresolved ? '部分配置引用未解析。' : ''}${!endpoints.length ? '未提取到数据库地址，排查未完成。' : ''}数据库连接尚未验证；需要独立配置的只读数据库连接。未返回账号密码或原配置。` };
}
export async function readEnvironment(plan, adapters = {}) {
  const config = adapters.config ?? await loadEnvironments(); const e = verifyApprovedPlan(config, plan);
  if (!plan.approvedBy) throw new Error('查询尚未批准');
  const q = e.queries[plan.queryId];
  try {
    const cred = await (adapters.credential ?? credential)(e.credentialRef);
    if (typeof cred.username !== 'string' || typeof cred.password !== 'string') throw new Error('credential');
    const result = await (e.kind === 'mysql' ? mysqlRead : nacosRead)(e, q, ...(e.kind === 'mysql' ? [plan.parameters, cred, adapters] : [cred, adapters]));
    while (Buffer.byteLength(JSON.stringify(result.rows)) > 24000) { result.rows.pop(); result.truncated = true; }
    return { ...result, evidence: { environmentId: plan.environmentId, queryId: plan.queryId, scopeHash: plan.scopeHash,
      readAt: new Date().toISOString(), rowCount: result.rows.length, resultHash: fingerprint(result.rows) } };
  } catch (error) {
    if (/^(本机凭据|数据库账号|无法核验|环境响应)/.test(error.message)) throw error;
    throw safeExecutionError(error);
  }
}
