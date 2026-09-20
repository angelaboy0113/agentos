import { canonicalWebsite, validateWebsiteAliases } from './website-aliases.js';
import { websiteUrl } from './website-policy.js';
import { validateAccountPolicy } from './database-account-policy.js';
import { validateToolQuery } from './environment-tool-policy.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const environmentFile = () => path.resolve(process.env.AGENTOS_ENVIRONMENTS_FILE ?? './config/environments.local.json');
const id = (s) => typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(s);
const sensitive = /password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function loadEnvironments(file = environmentFile()) {
  let v;
  try { v = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, environments: {} }; throw new Error('环境配置无法读取或解析；未执行查询'); }
  if (v.version !== 1 || !v.environments || typeof v.environments !== 'object' || Array.isArray(v.environments)) throw new Error('环境配置版本错误');
  validateWebsiteAliases(v);
  for (const [key, e] of Object.entries(v.environments)) {
    if (Object.keys(e).some((k) => !['projectId','tier','kind','credentialRef','ownerOpenIdsByProfile','membersRead','queries','host','port','database','tls','baseUrl','accountPolicy','businessAccountAuthorization'].includes(k)) || !id(key) || !id(e.projectId) || !['uat', 'prd'].includes(e.tier) || !['mysql', 'nacos', 'website'].includes(e.kind)
      || !id(e.credentialRef) || typeof e.membersRead !== 'boolean' || !e.ownerOpenIdsByProfile || !e.queries) throw new Error('环境配置字段无效');
    validateAccountPolicy(e);
    if(e.kind==='website')websiteUrl(e.baseUrl);
    if (Object.values(e.ownerOpenIdsByProfile).some((ids) => !Array.isArray(ids) || ids.some((x) => !/^ou_[A-Za-z0-9]+$/.test(x)))) throw new Error('环境审批人配置无效');
    if (e.kind === 'mysql' && (!/^[a-zA-Z0-9.:-]+$/.test(e.host) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || !id(e.database))) throw new Error('数据库目标配置无效');
    if (e.kind === 'nacos') { const u = new URL(e.baseUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname.replace(/\/$/, '') !== '/nacos') throw new Error('Nacos 地址必须是固定 /nacos 根路径'); }
    for (const [qid, q] of Object.entries(e.queries)) {
      if (!id(qid) || q.reviewed !== true || typeof q.description !== 'string' || !q.description.trim() || q.description.length > 200
        || !Number.isInteger(q.maxRows) || q.maxRows < 1 || q.maxRows > 200 || !Number.isInteger(q.timeoutMs) || q.timeoutMs < 100 || q.timeoutMs > 10000 || !Array.isArray(q.parameters)) throw new Error('查询模板尚未审核或限制无效');
      if (q.parameters.some((p) => !id(p.name) || sensitive.test(p.name) || !['string', 'integer'].includes(p.type))) throw new Error('查询参数定义无效');
      if (validateToolQuery(e, q)) continue;
      if (e.kind === 'mysql') {
        if (typeof q.sql !== 'string' || !/^SELECT\s/i.test(q.sql.trim()) || /;|--|\/\*|\b(INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|LOCK|SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK)\b/i.test(q.sql)
          || (q.sql.match(/\?/g) ?? []).length !== q.parameters.length || !Array.isArray(q.outputColumns) || !q.outputColumns.length || q.outputColumns.length > 12
          || q.outputColumns.some((x) => !id(x) || sensitive.test(x))) throw new Error('只允许审核后的单条 SELECT、绑定参数和非敏感输出列');
      } else if (typeof q.dataId !== 'string' || !q.dataId || typeof q.group !== 'string' || typeof q.namespace !== 'string' || q.parameters.length) throw new Error('Nacos 必须固定 namespace/group/dataId，不能由模型指定 URL');
    }
  }
  return v;
}
export function isEnvironmentOwner(e, actor) { return (e.ownerOpenIdsByProfile?.[actor.profile] ?? []).includes(actor.senderId); }
export function catalog(config, projectId) {
  return Object.entries(config.environments).filter(([, e]) => e.projectId === projectId && (e.kind !== 'website' || canonicalWebsite(config, projectId, e.tier, e.baseUrl) === websiteUrl(e.baseUrl))).map(([environmentId, e]) => ({ environmentId, tier: e.tier, kind: e.kind,
    queries: Object.entries(e.queries).map(([queryId, q]) => ({ queryId, description: q.description, ...(e.kind === 'nacos' && q.mode === 'investigate' ? { capabilities: ['数据库端点解析', 'XXL-JOB非敏感管理入口、启用开关和执行器名称发现；不读取原始配置或凭据'] } : {}), parameters: q.parameters, maxRows: q.maxRows, ...(q.mode === 'investigate' ? { mode: q.mode, browser: q.browser === true, progressPolicy: 'evidence-driven', scope: e.kind === 'website' ? {origin:new URL(e.baseUrl).origin,entryUrl:e.baseUrl} : e.kind === 'mysql' ? { tables: q.tables } : { namespaces: q.namespaces } } : {}) })) }));
}
export function planQuery(config, request, projectId, actor, now = Date.now()) {
  const original = config.environments[request?.environmentId];
  if(original?.projectId===projectId && original.kind==='website'){
    const url=canonicalWebsite(config,projectId,original.tier,original.baseUrl);
    if(url!==websiteUrl(original.baseUrl)){
      const target=Object.entries(config.environments).find(([,e])=>e.projectId===projectId&&e.tier===original.tier&&e.kind==='website'&&websiteUrl(e.baseUrl)===url);
      if(!target)throw new Error('正确业务域名尚未登记；需发现并登记更正后的入口');
      request={...request,environmentId:target[0]};
    }
  }
  const e = config.environments[request?.environmentId], q = e?.queries?.[request?.queryId];
  if (!e || e.projectId !== projectId || !q) throw new Error('环境或查询模板未配置；请管理员在本机配置');
  if (!Array.isArray(request.parameters) || request.parameters.length !== q.parameters.length) throw Object.assign(new Error('查询参数不完整'), {queryDiagnostic:{code:'PARAMETER_COUNT',expected:q.parameters.length,actual:Array.isArray(request.parameters)?request.parameters.length:null}});
  const parameters = q.parameters.map((p, i) => {
    const v = request.parameters[i];
    if (p.type === 'integer') { if (!/^-?\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v) < (p.min ?? 0) || Number(v) > (p.max ?? 1000000000)) throw Object.assign(new Error('查询数值参数超出范围'),{queryDiagnostic:{code:'INTEGER_PARAMETER',index:i,min:p.min??0,max:p.max??1000000000}}); return Number(v); }
    if (typeof v !== 'string' || !v.length || v.length > Math.min(p.maxLength ?? 100, 200) || /[\x00-\x1f\x7f]/.test(v)) throw Object.assign(new Error('查询文本参数无效'),{queryDiagnostic:{code:'TEXT_PARAMETER',index:i,maxLength:Math.min(p.maxLength??100,200),length:typeof v==='string'?v.length:null,reason:typeof v!=='string'?'type':!v.length?'empty':/[\x00-\x1f\x7f]/.test(v)?'control_characters':'length'}});
    return v;
  });
  const scope = { expiresAt: new Date(now + 15 * 60000).toISOString(), approvalProfile: actor.profile, environmentId: request.environmentId, queryId: request.queryId, projectId, parameters, configHash: fingerprint(e), maxRows: q.maxRows, timeoutMs: q.timeoutMs };
  const approvalRequired = false;
  return { ...scope, description: q.description + (q.mode === 'investigate' ? `；范围：${e.kind === 'website' ? new URL(e.baseUrl).origin : e.kind === 'nacos' ? q.namespaces.map(x => x || 'public').join(', ') : q.tables.join(', ')}；按证据推进，无固定调用次数上限；连续3次无新增证据暂停` : ''), tier: e.tier, kind: e.kind, scopeHash: fingerprint(scope),
    approvalRequired, approvalOwnerIds: [...(e.ownerOpenIdsByProfile[actor.profile] ?? [])], approvedBy: 'policy:read-only', approvedAt: new Date(now).toISOString() };
}
export function verifyPlan(config, plan, now = Date.now()) {
  const e = config.environments[plan.environmentId];
  if (!e || fingerprint(e) !== plan.configHash || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now) throw new Error('查询授权已过期或配置已变更，请重新申请');
  const scope = Object.fromEntries(['expiresAt','approvalProfile','environmentId','queryId','projectId','parameters','configHash','maxRows','timeoutMs'].map((k) => [k, plan[k]]));
  if (fingerprint(scope) !== plan.scopeHash || e.projectId !== plan.projectId) throw new Error('查询范围与批准内容不一致');
  return e;
}

export function verifyApprovedPlan(config, plan, now = Date.now()) {
  const e = verifyPlan(config, plan, now);
  const owner = (e.ownerOpenIdsByProfile[plan.approvalProfile] ?? []).includes(plan.approvedBy);
  const policy = plan.approvedBy === 'policy:read-only' && !plan.approvalRequired;
  const legacyPolicy = plan.approvedBy === 'policy:uat-read' && e.tier === 'uat' && e.membersRead && !plan.approvalRequired;
  if (!owner && !policy && !legacyPolicy) throw new Error('查询尚未批准或批准人不属于当前环境负责人');
  return e;
}
