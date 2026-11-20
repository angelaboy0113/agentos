import test from 'node:test';
import assert from 'node:assert/strict';
import {planWebsiteReadReview} from '../src/shared/website-read-review.js';
import {websiteRequestBoundary} from '../src/shared/website-policy.js';

const review={environmentId:'approved',projectId:'example',tier:'prd',origin:'https://example.test',
 queryId:'inspect',method:'POST',path:'/workflow/page/calendar',sourceCommit:'a'.repeat(40),evidence:'Controller to scoped SELECT'};
const config=()=>({environments:{approved:{kind:'website',projectId:'example',tier:'prd',baseUrl:review.origin,
 queries:{inspect:{mode:'investigate',reviewed:true,readEndpoints:[]}}}}});
const request={url:review.origin+review.path,method:'POST',resourceType:'xhr',body:'{}'};
test('exact reviewed read is idempotent and preserves method and mutation boundaries',()=>{
 const cfg=config(), plan=planWebsiteReadReview(cfg,review), rules=plan.next;
 assert.equal(websiteRequestBoundary(review.origin,request,false,rules).allowed,true);
 for(const r of [{...request,method:'GET'}, {...request,url:request.url+'/other'}, {...request,body:'{"action":"update"}'}]){
  assert.equal(websiteRequestBoundary(review.origin,r,false,rules).allowed,false);
 }
 assert.equal(cfg.environments.approved.queries.inspect.readEndpoints.length,0);
 cfg.environments.approved.queries.inspect.readEndpoints=rules;
 assert.equal(planWebsiteReadReview(cfg,review),null);
});
test('review cannot extend host, project, method, path family or write operations',()=>{
 for(const changes of [{projectId:'other'},{tier:'uat'},{origin:'https://foreign.test'},{queryId:'other'},{method:'GET'},
  {path:'/workflow/delete'},{path:'/workflow/{integerId}/calendar'},{path:'//foreign.test/calendar'},{sourceCommit:'unknown'},{evidence:''}]){
  assert.throws(()=>planWebsiteReadReview(config(), {...review,...changes}));
 }
});
