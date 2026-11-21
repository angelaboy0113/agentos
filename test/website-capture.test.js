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

test('PRD captures a real browser PNG only for the confirmed visible target',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'prd-capture-'));
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(req.url==='/detail/pane'?'<main><h1>内嵌订单明细</h1><p>参考示意</p></main>':
   '<main style="background:#b34737;padding:30px"><h1>订单详情</h1><h2 hidden>首页</h2><p>本页模拟测试数据</p><button>查看</button><iframe src="/detail/pane"></iframe></main>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP prd-capture.test 127.0.0.1']})};
 const browser=new WebsiteBrowser(dir,driver);
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const baseUrl=`http://prd-capture.test:${server.address().port}/detail`,environment={projectId:'orders',tier:'uat',baseUrl};
 const job={id:'prd-capture-job',projectId:'orders',sourceEnvironment:'sit',prd:{auto:true,revision:1}};
 await browser.run(job,environment,'browser_open');
 await assert.rejects(browser.run(job,environment,'browser_screenshot',{}),{code:'BROWSER_ARGUMENTS'});
 await assert.rejects(browser.run(job,environment,'browser_screenshot',{url:baseUrl,targetText:'首页'}),{code:'BROWSER_CONTENT_CHANGED'});
 const captured=await browser.run(job,environment,'browser_screenshot',{url:baseUrl,targetText:'订单详情'});
 assert.equal(captured.designReference.pageUrl,baseUrl);
 assert.ok(captured.designReference.bytes>100);
 assert.equal(captured.screenshot,undefined);
 const frames=await browser.run(job,environment,'browser_frames');
 const pane=frames.frames.find(frame=>frame.url===baseUrl+'/pane');
 await browser.run(job,environment,'browser_frame',{ref:pane.ref});
 const framed=await browser.run(job,environment,'browser_screenshot',{url:pane.url,targetText:'内嵌订单明细'});
 assert.equal(framed.designReference.pageUrl,pane.url);
 assert.ok(framed.designReference.bytes>100);
});

test('PRD list captures require actual rows and replace sensitive cells without flattening state', async t => {
 const driver=await chromium.launch({headless:true});
 t.after(()=>driver.close());
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'prd-list-evidence-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const page=await driver.newPage({viewport:{width:800,height:450}});
 const browser=new WebsiteBrowser(dir);
 browser.loginStatus=async()=>({loginRequired:false});
 browser.snapshot=async()=>({controls:[]});
 const job={id:'prd-list',prd:{auto:true,inlinePrototypes:true}};
 const url='https://example.test/activity';
 const capture=(args={})=>browser.screenshot({page,job},{url,targetText:'活动查询',...args});
 const html=(cells)=>`<h1>活动查询</h1><input aria-label="活动编号"><button>查询</button>
 <div class="ant-table">
 <table style="width:100%;table-layout:fixed"><thead><tr><th>活动编号</th><th>客户名称</th><th>活动状态</th></tr></thead></table>
 <table style="width:100%;table-layout:fixed"><tbody>${cells}</tbody></table></div>`;
 const empty='<tr class="ant-table-placeholder"><td colspan="3">没有数据</td></tr>';
 await page.route(url,route=>route.fulfill({contentType:'text/html;charset=utf-8',body:html(empty)}));
 await page.goto(url);
 const initial=await capture();
 assert.equal(initial.pageStatus,'list_requires_rows');
 assert.equal(initial.designReference,undefined);
 assert.equal((await capture({emptyState:true})).designReference.tableCapture.visibleRows,0);
 await page.locator('tbody').evaluate(box=>{
  box.innerHTML='<tr><td>PRD-PRIVATE-A</td><td>PRIVATE CUSTOMER A</td><td><span style="color:red;background:#fee">审批中</span></td></tr>';
 });
 const populated=await capture();
 assert.deepEqual(populated.designReference.tableCapture,{tables:1,visibleRows:1,sampleFields:2,preservedStates:1});
 assert.deepEqual(populated.designLayout.samples.map(x=>x.text),['ACT-DEMO-001','示例单位 001']);
 assert(populated.designLayout.controls.some(c=>c.text==='审批中'&&c.color==='rgb(255, 0, 0)'));
 assert.doesNotMatch(JSON.stringify(populated),/PRD-PRIVATE-A|PRIVATE CUSTOMER A/);
 await page.locator('td').nth(0).evaluate(cell=>{cell.textContent='PRD-PRIVATE-B';});
 await page.locator('td').nth(1).evaluate(cell=>{cell.textContent='PRIVATE CUSTOMER B';});
 assert.equal((await capture()).designReference.sha256,populated.designReference.sha256);
 assert.equal(await page.locator('td').evaluateAll(cells=>cells.some(cell=>cell.getAttributeNames().some(name=>name.includes('agentos-label')))),false);
});
