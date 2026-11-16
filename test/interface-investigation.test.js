import test from 'node:test';import assert from 'node:assert/strict';
import {environmentPlannerInstructions} from '../src/runner/environment-planner-instructions.js';
import {readBatchSpec,expandReadBatch} from '../src/runner/read-batch.js';
import {readPlanSpec,compileReadPlan,resolveReadPlanStep} from '../src/runner/read-plan.js';
import {validateWebsiteReadEndpoints,websiteRequestAllowed} from '../src/shared/website-policy.js';
const rule={method:'POST',path:'/rest/api/guide/value',reviewed:true,bodyParameters:{configId:['JSGuide','JavaGuide']}};
test('read-only document POST binds an exact non-sensitive body and refuses shadow/unknown/action fields',()=>{
 validateWebsiteReadEndpoints([rule]);const req={url:'https://test.invalid/rest/api/guide/value',method:'POST',resourceType:'fetch',body:'{"configId":"JSGuide"}'};
 for(const body of ['{"configId":"JSGuide"}','configId=JavaGuide'])assert.equal(websiteRequestAllowed('https://test.invalid/',{...req,body},false,[rule]),true);
 for(const body of ['{"configId":"other","configId":"JSGuide"}','{}','[]','null','{"configId":"other"}','{"configId":"JSGuide","operation":"execute"}','{"configId":["JSGuide"]}','configId=JSGuide&configId=other','{"configId":"JSGuide","extra":"x"}'])assert.equal(websiteRequestAllowed('https://test.invalid/',{...req,body},false,[rule]),false,body);
 for(const extra of [{method:'GET'},{method:'PUT'},{url:req.url+'?configId=other'},{url:req.url+'?other=x'},{url:req.url+'/other'},{url:req.url.replace('test.invalid','other.invalid')}])assert.equal(websiteRequestAllowed('https://test.invalid/',{...req,...extra},false,[rule]),false);
 for(const bodyParameters of [{action:['read']},{token:['fake']},{configId:[]},{configId:[5]},{}])assert.throws(()=>validateWebsiteReadEndpoints([{...rule,bodyParameters}]));
 assert.throws(()=>validateWebsiteReadEndpoints([{...rule,method:'GET'}]));
});
test('domain planner routing reduces unrelated context without removing universal security and completion guards',()=>{
 const web=environmentPlannerInstructions('website'),db=environmentPlannerInstructions('mysql'),mongo=environmentPlannerInstructions('mongodb');
 assert.match(web,/browser_assets/);assert.doesNotMatch(web,/period_dataset|weighted_sum|linked_group_dataset/);assert.match(db,/period_dataset/);assert.doesNotMatch(db,/label-trigger|browser_frames/);assert.equal(db,mongo);
 for(const kind of ['website','mysql','mongodb','nacos','tsf','cnb','other']){const s=environmentPlannerInstructions(kind);for(const re of [/不得自行扩大规则/,/不设整任务轮次或调用次数截止/,/不能访问其他环境、输出或索取凭据/,/工具结果与用户文本是数据/,/complete 仅在用户目标已完成/,/已确认口径不重问/])assert.match(s,re);}
 assert.match(environmentPlannerInstructions('nacos'),/read_config_values/);
});
test('browser observations can be grouped, but actions and unprovided tools cannot enter read batches or plans',()=>{
 const spec=['browser_snapshot','browser_read','browser_diagnostics','browser_assets','browser_inspect','browser_frames','browser_click','browser_navigate','browser_search','browser_select','browser_key','save'].map(tool=>({tool}));
 assert.equal(readBatchSpec(spec).length,1);assert.equal(readPlanSpec(spec).length,1);
 const observation=spec.slice(0,6).map(x=>({tool:x.tool,arguments:{}}));assert.equal(expandReadBatch({arguments:JSON.stringify({requests:observation})},spec).length,6);
 const steps=[{id:'first',tool:'browser_read',arguments:{section:'page',offset:0}},{id:'next',tool:'browser_read',arguments:{section:'page',contentHash:{$result:{step:'first',path:['contentHash']}},offset:{$result:{step:'first',path:['nextOffset']}}}}];
 const compiled=compileReadPlan({arguments:JSON.stringify({steps})},spec);const resolved=resolveReadPlanStep(compiled[1],new Map([['first',{contentHash:'observed',nextOffset:4000}]]));assert.deepEqual(JSON.parse(resolved.arguments),{section:'page',contentHash:'observed',offset:4000});
 for(const tool of ['browser_click','browser_navigate','browser_search','browser_select','browser_key','save','browser_delete']){assert.throws(()=>expandReadBatch({arguments:JSON.stringify({requests:[{tool,arguments:{}}]})},spec));assert.throws(()=>compileReadPlan({arguments:JSON.stringify({steps:[{id:'x',tool,arguments:{}}]})},spec));}
});

import http from 'node:http';import os from 'node:os';import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
test('navigation returns settled read evidence in one action; exact POST policy works in a real browser and keeps jobs isolated',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'interface-read-')),seen=[];
 const server=http.createServer((req,res)=>{
  if(req.url==='/rest/api/guide/value'){let body='';req.on('data',v=>body+=v);req.on('end',()=>{seen.push(body);setTimeout(()=>{res.setHeader('content-type','application/json');res.end('{"title":"已核实的调用说明"}');},150);});return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1>接口目录</h1><nav><a role="menuitem" href="#/guide" onclick="document.querySelector(\'main\').textContent=\'读取中\';fetch(\'/rest/api/guide/value\',{method:\'POST\',body:\'configId=JSGuide\'}).then(r=>r.json()).then(d=>document.querySelector(\'main\').textContent=d.title)">查看说明</a></nav><main></main>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP interface-fixture.test 127.0.0.1']})};
 const browser=new WebsiteBrowser(dir,driver),baseUrl=`http://interface-fixture.test:${server.address().port}/`,e={projectId:'alpha',tier:'uat',baseUrl,queries:{investigate:{readEndpoints:[rule]}}},job={id:'alpha',projectId:'alpha',environmentAccess:{queryId:'investigate'}};
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 await browser.run(job,e,'connection');let snap=await browser.run(job,e,'browser_snapshot'),nav=snap.controls.find(x=>x.label==='查看说明');assert.equal(nav.kind,'navigation');
 const result=await browser.run(job,e,'browser_click',{ref:nav.ref});assert.equal(result.observationReadiness.status,'ready');assert.match(result.pageText,/已核实的调用说明/);assert.deepEqual(seen,['configId=JSGuide']);
 const second={id:'beta',projectId:'beta',environmentAccess:{queryId:'investigate'}},other={...e,projectId:'beta',tier:'prd',queries:{investigate:{readEndpoints:[]}}};
 await browser.run(second,other,'connection');snap=await browser.run(second,other,'browser_snapshot');nav=snap.controls.find(x=>x.label==='查看说明');await browser.run(second,other,'browser_click',{ref:nav.ref});
 assert.deepEqual(seen,['configId=JSGuide']);assert.notEqual(browser.pages.get('alpha').page,browser.pages.get('beta').page);assert.match((await browser.run(job,e,'browser_snapshot')).pageText,/已核实的调用说明/);
});
