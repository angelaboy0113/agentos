import { parseAllDocuments } from 'yaml';
const sensitive = /password|passwd|secret|token|credential|private.?key|username/i;
// Parse data only: no custom tags, merges, environment variables, files or evaluation.
function configurationValues(source) {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('配置过大，未解析');
  const values = new Map();
  const collect = (v, prefix = '', depth = 0) => {
    if (depth > 30 || values.size > 10000) throw new Error('配置结构超过限制');
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) if (!['__proto__','prototype','constructor'].includes(k)) collect(x, prefix ? `${prefix}.${k}` : k, depth + 1); }
    else if (typeof v === 'string' || typeof v === 'number') values.set(prefix, String(v));
  };
  // Properties and YAML are distinct formats. Never fall back to raw text after malformed YAML.
  if (/^\s*[^#!\s][^\n=:]*\s*=/m.test(source) && !/^\s*\w+:\s*$/m.test(source)) {
    for (const line of source.split(/\r?\n/)) { const m = /^\s*([^#!\s][^=]*?)\s*=\s*(.*)$/.exec(line); if (m) values.set(m[1], m[2]); }
  } else {
    const docs = parseAllDocuments(source, { schema: 'core', merge: false, uniqueKeys: true });
    if (docs.length > 10 || docs.some(d => d.errors.length || d.warnings.length)) throw new Error('配置格式无法安全解析');
    try { for (const d of docs) collect(d.toJS({ maxAliasCount: 0 })); } catch { throw new Error('配置结构无法安全解析'); }
  }
  return values;
}
export function databaseEndpoints(source) {
  const values = configurationValues(source);
  const resolve = (v, seen = []) => {
    if (seen.length > 16 || v.length > 16000) throw new Error('配置引用无法解析');
    return v.replace(/\$\{([^{}]+)\}/g, (_, key) => {
      // Do not resolve secrets or consult process.env; unresolved dependencies are explicit gaps.
      if (sensitive.test(key) || !values.has(key) || seen.includes(key)) throw new Error('配置引用缺失或循环，未完成地址解析');
      return resolve(values.get(key), [...seen, key]);
    });
  };
  const result = new Map(); let unresolved = false;
  for (const [key, value] of values) {
    if (sensitive.test(key) || !value.includes('jdbc:mysql://')) continue;
    let url; try { url = resolve(value.split('?')[0]); } catch { unresolved = true; continue; }
    const m = /^jdbc:mysql:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9_-]+)(?:\?|$)/.exec(url);
    if (!m || Number(m[2] ?? 3306) < 1 || Number(m[2] ?? 3306) > 65535) { unresolved = true; continue; }
    const host = m[1], port = Number(m[2] ?? 3306), database = m[3];
    result.set(`${host}:${port}/${database}`, { server: `${host}${m[2] ? ':' + port : ''}`, host, port, database, driver: 'mysql' });
  }
  const rows = [...result.values()];
  Object.defineProperty(rows, 'unresolved', { value: unresolved });
  return rows;
}

// Private local extraction. This return value must never enter model input, state or logs.
export function databaseCredential(source, target) {
 const values=configurationValues(source);
 const resolve=(v,seen=[])=>{
  if(typeof v!=='string' || v.length>16000 || seen.length>16) throw new Error('配置凭据不可解析');
  const out=v.replace(/\$\{([^{}]+)\}/g,(_,key)=>{
   if(!values.has(key)||seen.includes(key)) throw new Error('凭据引用缺失或循环');
   return resolve(values.get(key),[...seen,key]);
  });
  if(/\$\{|ENC\(/.test(out))throw new Error('外部或加密凭据未解析');return out;
 };
 const found=[];
 for(const [key,value] of values) {
  if(!/(^|\.)(url|jdbc-url|jdbcUrl)$/.test(key) || !value.startsWith('jdbc:mysql://'))continue;
  const url=resolve(value.split('?')[0]);const m=/^jdbc:mysql:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9_-]+)$/.exec(url);
  if(!m||m[1]!==target.host||Number(m[2]??3306)!==target.port||m[3]!==target.database)continue;
  const prefix=key.slice(0,key.lastIndexOf('.')+1);
  const username=resolve(values.get(prefix+'username')),password=resolve(values.get(prefix+'password'));
  if(!username||!password||username.length>1000||password.length>8000)throw new Error('凭据字段无效');
  found.push({username,password});
 }
 const unique=[...new Map(found.map(x=>[JSON.stringify(x),x])).values()];
 if(unique.length!==1)throw new Error('目标数据库凭据缺失或存在多个不同账号');return unique[0];
}
