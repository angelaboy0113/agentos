import {fingerprint} from './environment-access.js';

// Only references already returned to this leased job, from its own project and
// runtime tier. Configuration fingerprints revoke access when a source changes.
// Other projects remain behind their explicit investigation boundary.
export function priorToolResults(job,config,plan){
 const refs=new Map();
 if(!job?.id||plan?.projectId!==job.projectId||!plan.tier)return refs;
 for(const entry of job.context??[]){
  const result=entry?.result,evidence=result?.environmentEvidence,e=config?.environments?.[evidence?.environmentId];
  if(!e||e.projectId!==job.projectId||e.tier!==plan.tier||!e.queries?.[evidence.queryId]||e.queries[evidence.queryId].mode!=='investigate')continue;
  const scope=fingerprint(e);
  if(evidence.configHash&&evidence.configHash!==scope)continue;
  if(evidence.projectId&&evidence.projectId!==e.projectId||evidence.requestingProjectId&&evidence.requestingProjectId!==job.projectId)continue;
  for(const item of result.toolResultCatalog??[])if(/^tool-result-[a-f0-9-]{36}$/.test(item.resultRef??''))refs.set(item.resultRef,{scope,environmentId:evidence.environmentId,queryId:evidence.queryId,projectId:e.projectId,tier:e.tier});
 }
 return refs;
}
