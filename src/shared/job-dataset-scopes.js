import {fingerprint} from './environment-access.js';

// A cross-system investigation may revisit an immutable dataset that this same
// job already captured.  This is deliberately narrower than sharing datasets
// between jobs: the export directory is still job-local and TaskDatasetStore
// still verifies the real path, symlink boundary, scope and content digest.
export function verifiedPriorDatasetScopes(job,config,plan){
 const allowedProjects=new Set([job?.projectId,plan?.projectId].filter(Boolean));
 if(!job?.id||!plan?.tier||!allowedProjects.size)return[];
 const scopes=[];
 for(const entry of job.context??[]){
  const evidence=entry?.result?.environmentEvidence;
  if(!evidence||!(evidence.completeDatasetCount>0)||typeof evidence.environmentId!=='string')continue;
  const environment=config?.environments?.[evidence.environmentId];
  if(!environment||!allowedProjects.has(environment.projectId)||environment.tier!==plan.tier||!['mysql','mongodb'].includes(environment.kind))continue;
  if(evidence.projectId!==undefined&&evidence.projectId!==environment.projectId)continue;
  if(evidence.requestingProjectId!==undefined&&evidence.requestingProjectId!==job.projectId)continue;
  scopes.push(fingerprint(environment));
 }
 return[...new Set(scopes)];
}
