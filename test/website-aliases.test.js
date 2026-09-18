import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalWebsite,validateWebsiteAliases} from '../src/shared/website-aliases.js';
import {catalog,planQuery,verifyApprovedPlan} from '../src/shared/environment-access.js';
const old='http://192.0.2.1/mp-runtime/',domain='https://uat.example.com/';
const alias={projectId:'demo',tier:'uat',from:old,to:domain};
const env=url=>({projectId:'demo',tier:'uat',kind:'website',baseUrl:url,membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{description:'只读页面',parameters:[{name:'purpose',type:'string'}],mode:'investigate',maxRows:20,timeoutMs:1000}}});
test('confirmed website corrections preserve environment, application path and unrelated service entries',()=>{
 const cfg={websiteAliases:[alias]};assert.equal(canonicalWebsite(cfg,'demo','uat',old),domain);
 assert.equal(canonicalWebsite(cfg,'demo','prd',old),old);assert.equal(canonicalWebsite(cfg,'other','uat',old),old);
 assert.equal(canonicalWebsite(cfg,'demo','uat','http://192.0.2.1/xxl-job-admin'),'http://192.0.2.1/xxl-job-admin');
 assert.equal(canonicalWebsite(cfg,'demo','uat','http://192.0.2.1/api'),'http://192.0.2.1/api');
});
test('new plans referencing old IDs use canonical environment policy; old approved scope is not rewritten',()=>{
 const cfg={version:1,environments:{old:env(old),canonical:env(domain)}};
 const request={environmentId:'old',queryId:'investigate',parameters:['核实单据']};
 const existing=planQuery(cfg,request,'demo',{profile:'owner',senderId:'ou_member'});
 cfg.websiteAliases=[alias];cfg.environments.canonical.membersRead=false;
 const p=planQuery(cfg,request,'demo',{profile:'owner',senderId:'ou_member'});
 assert.equal(p.environmentId,'canonical');assert.equal(p.approvalRequired,true);assert.equal(p.approvedBy,null);assert.notEqual(p.scopeHash,existing.scopeHash);
 assert.deepEqual(catalog(cfg,'demo').map(x=>x.environmentId),['canonical']);
 assert.equal(verifyApprovedPlan(cfg,existing).baseUrl,old);
 delete cfg.environments.canonical;assert.throws(()=>planQuery(cfg,request,'demo',{profile:'owner',senderId:'ou_member'}),/尚未登记/);
});
test('ambiguous, chained and credential-bearing corrections fail validation',()=>{
 for(const list of [[alias,alias],[alias,{...alias,from:domain,to:old}],[{...alias,to:'https://user:password@uat.example.com/'}],[{...alias,to:old}]])assert.throws(()=>validateWebsiteAliases({websiteAliases:list}));
});
