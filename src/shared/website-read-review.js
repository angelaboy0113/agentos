import {validateWebsiteReadEndpoints, websiteRequestBoundary} from './website-policy.js';

// Only the local maintenance entry calls this after examining the implementation.
// A blocked request is a candidate to investigate, never evidence that it is read-only.
export function planWebsiteReadReview(config, review) {
  const {environmentId, projectId, tier, origin, queryId, path, sourceCommit, evidence} = review;
  const environment = config.environments[environmentId];
  const query = environment?.queries?.[queryId];
  if (environment?.kind !== 'website' || environment.projectId !== projectId || environment.tier !== tier
      || new URL(environment.baseUrl).origin !== origin || query?.mode !== 'investigate' || query.reviewed !== true) {
    throw Error('Read review scope must match one existing website investigation');
  }
  if (review.method !== 'POST' || !/^[0-9a-f]{40,64}$/i.test(sourceCommit ?? '')
      || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500) {
    throw Error('Exact observed POST and fixed source evidence are required');
  }
  const rule = {method:'POST',path,reviewed:true};
  validateWebsiteReadEndpoints([rule]);
  const rules = query.readEndpoints ?? [];
  if (rules.some(existing => existing.method === rule.method && existing.path === rule.path)) return null;

  const request = {url:new URL(rule.path,origin).href,method:rule.method,resourceType:'xhr',body:'{}'};
  if (websiteRequestBoundary(environment.baseUrl,request,false,rules).code !== 'READ_ENDPOINT_REVIEW_REQUIRED') {
    throw Error('Path is already readable or outside the reviewable request boundary');
  }
  const next = [...rules,rule];
  validateWebsiteReadEndpoints(next);
  if (!websiteRequestBoundary(environment.baseUrl,request,false,next).allowed) {
    throw Error('Reviewed rule did not permit the exact request');
  }
  return {rule,next};
}
