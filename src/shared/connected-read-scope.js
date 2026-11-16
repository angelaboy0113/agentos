import {fingerprint} from './environment-access.js';

// Offline deployment preparation only. The planner cannot supply this policy or
// change a running grant. Existing account, database, transport and tier stay fixed.
export function prepareConnectedReadScope(config, policy) {
 if(policy?.version!==1||!Array.isArray(policy.projects)||!policy.projects.length||!Array.isArray(policy.tiers)||!policy.tiers.length||policy.tiers.some(t=>!['uat','prd'].includes(t))||policy.projects.some(p=>typeof p!=='string'||!/^[A-Za-z][A-Za-z0-9_-]*$/.test(p)))throw Error('Explicit connected read deployment policy required');
 const result=structuredClone(config),groups=new Map(),audit=[];
 for(const [id,e] of Object.entries(result.environments??{})){
  if(!policy.projects.includes(e.projectId)||!policy.tiers.includes(e.tier)||!['mysql','mongodb'].includes(e.kind)||['admin','local','config','mysql','information_schema','performance_schema','sys'].includes(e.database))continue;
  const q=Object.values(e.queries??{}).find(q=>q.reviewed===true&&q.mode==='investigate');if(!q)continue;
  const key=fingerprint({projectId:e.projectId,tier:e.tier,kind:e.kind,host:e.host,port:e.port,database:e.database,credentialRef:e.credentialRef,transport:e.transport,authSource:e.authSource,tls:e.tls});
  const entries=groups.get(key)??[];entries.push({id,e,q});groups.set(key,entries);
 }
 for(const entries of groups.values()){
  const existing=entries.find(({e})=>Object.values(e.queries).some(q=>q.reviewed===true&&q.mode==='investigate'&&!q.requiredFilters?.length&&(e.kind==='mysql'?q.tables:q.collections)?.includes('*')));
  if(existing){audit.push({environmentId:existing.id,kind:existing.e.kind,projectId:existing.e.projectId,tier:existing.e.tier,action:'reuse-existing-database-read'});continue;}
  const {id,e,q}=entries.find(x=>!x.q.requiredFilters?.length)??entries[0];
  if(e.queries.connected_read)throw Error('Existing connected_read query must be reviewed, not overwritten');
  const query=structuredClone(q);delete query.requiredFilters;
  if(e.kind==='mysql')query.tables=['*'];else query.collections=['*'];
  query.description='已由部署管理员授权的本系统当前数据库只读调查：先发现实际表/集合和字段，再按本问题取证；保留原账号、环境、传输与敏感字段保护，不执行写入或重放。';
  query.exportMaxRows='all';e.queries.connected_read=query;
  audit.push({environmentId:id,queryId:'connected_read',kind:e.kind,projectId:e.projectId,tier:e.tier,action:'add-explicit-database-read',existingQueriesPreserved:true});
 }
 return {config:result,audit,policy:{version:1,projects:[...policy.projects],tiers:[...policy.tiers]},runtimeGrantChanged:false};
}
