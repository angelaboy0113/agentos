import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {screenshotSecretSelector,waitForCaptureReady} from '../src/shared/website-capture.js';

test('capture waits for delayed API and rendered readonly values, keeps business fields and masks only secrets',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'capture-readiness-'));
 const server=http.createServer((req,res)=>{if(req.url==='/query'){setTimeout(()=>{res.setHeader('content-type','application/json');res.end('{"name":"测试经销商","amount":"1199.00"}');},700);return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1>订单详情</h1><div id="loading" role="progressbar">加载中</div><input readonly id="customer"><input disabled id="amount"><input name="access_token" value="synthetic-token"><div data-sensitive>synthetic-explicit-secret</div><script>fetch("/query").then(r=>r.json()).then(data=>{document.querySelector("#customer").value=data.name;setTimeout(()=>{document.querySelector("#amount").value=data.amount;document.querySelector("#loading").remove()},150)})</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP capture-fixture.test 127.0.0.1']})};
 const browser=new WebsiteBrowser(dir,driver);t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const job={id:'capture-job'},e={projectId:'different-project',tier:'uat',baseUrl:`http://capture-fixture.test:${server.address().port}/`};await browser.run(job,e,'connection');const state=browser.pages.get(job.id),page=state.page;
 let options;const original=page.screenshot.bind(page);page.screenshot=async args=>{options=args;assert.equal(state.pendingReads.size,0);assert.equal(await page.locator('#customer').inputValue(),'测试经销商');assert.equal(await page.locator('#amount').inputValue(),'1199.00');return original(args);};
 const result=await browser.run(job,e,'browser_screenshot');assert.equal(result.screenshot.readiness.status,'ready');assert.ok(result.screenshot.readiness.waitedMs>=500);assert.equal(options.maskColor,'#6b7280');assert.equal(await page.locator('#customer').evaluate((el,selector)=>el.matches(selector),screenshotSecretSelector),false);assert.equal(await page.locator('#amount').evaluate((el,selector)=>el.matches(selector),screenshotSecretSelector),false);assert.equal(await options.mask[0].count(),2);assert.doesNotMatch(JSON.stringify(result),/synthetic-token|synthetic-explicit-secret/);
 // A visible password is a credential field; login forms still cannot be captured.
 await page.evaluate(()=>{const x=document.createElement('input');x.type='password';document.body.append(x);});assert.equal((await browser.run(job,e,'browser_screenshot')).loginRequired,true);
});

test('capture gate reports ongoing requests, spinners and blank pages without claiming completion',async()=>{
 const pending={page:{evaluate:async()=>({loading:false,blank:false,documentReady:true,signature:'same'}),waitForTimeout:ms=>new Promise(r=>setTimeout(r,ms))},pendingReads:new Set(['request']),lastReadActivity:Date.now()};
 let result=await waitForCaptureReady(pending,{timeoutMs:30,quietMs:5,sampleMs:5});assert.equal(result.status,'loading_timeout');assert.equal(result.pendingRequests,1);
 pending.pendingReads.clear();pending.page.evaluate=async()=>({loading:true,blank:false,documentReady:true,signature:'same'});result=await waitForCaptureReady(pending,{timeoutMs:30,quietMs:5,sampleMs:5});assert.equal(result.loadingIndicator,true);assert.equal(result.status,'loading_timeout');
 pending.page.evaluate=async()=>({loading:false,blank:true,documentReady:true,signature:'same'});assert.equal((await waitForCaptureReady(pending,{timeoutMs:30,quietMs:5,sampleMs:5})).status,'blank_timeout');
});
