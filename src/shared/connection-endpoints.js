// Connection metadata only. Never retain usernames, passwords or arbitrary row fields.
export function connectionEndpoints(rows = []) {
 const unique = new Map();
 for (const r of rows) {
  if (!r || typeof r.host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(r.host) || !/^[a-zA-Z0-9_-]+$/.test(r.database ?? '')) continue;
  const port = Number(r.port); if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
  const source=r.connectionSource;
  const validSource=source && ['namespace','group','dataId'].every(k=>typeof source[k]==='string' && source[k].length<256) && /^[a-f0-9]{64}$/.test(source.contentHash??'');
  const value = {host:r.host,port,database:r.database,...(validSource?{connectionSource:{namespace:source.namespace,group:source.group,dataId:source.dataId,contentHash:source.contentHash}}:{})}; unique.set(`mysql://${value.host}:${port}/${value.database}`,value);
 }
 return [...unique].slice(0,20).map(([url,value])=>({...value,url}));
}
export function connectionCandidates(state, turn, projectId) {
 const ids = new Set(); let q = state.questions?.[turn.questionId];
 while(q && !ids.has(q.id)) {ids.add(q.id); q=state.questions[q.parentQuestionId];}
 return (state.jobs ?? []).filter(j=>ids.has(j.questionId) && j.chatId===turn.chatId && j.projectId===projectId
  && j.originProfile===turn.profile && j.status==='completed' && j.environmentAccess?.startedAt
  && ['ready','partial'].includes(j.result?.outcome) && Date.now()-Date.parse(j.updatedAt)<86400000
  && j.result?.environmentEvidence?.scopeHash===j.environmentAccess.scopeHash)
 .flatMap(j=>connectionEndpoints(j.result?.connectionEndpoints).map(e=>({...e,tier:j.environmentAccess.tier,sourceJobId:j.id,sourceEnvironmentId:j.environmentAccess.environmentId,sourceQueryId:j.environmentAccess.queryId,sourceConfigHash:j.environmentAccess.configHash,readAt:j.result.environmentEvidence.readAt})))
 .filter((e,i,a)=>a.findIndex(x=>x.url===e.url && x.tier===e.tier)===i).slice(0,20);
}
