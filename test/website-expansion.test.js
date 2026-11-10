import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';
import {validateBrowserTool} from '../src/shared/browser-tool-input.js';
import {websiteTools} from '../src/runner/environment-job.js';
import {controlMetadata,controlMetadataBatch} from '../src/shared/website-controls.js';
const html=`<style>.extra{display:none}.custom{cursor:pointer}</style><h1>Warehouse filters</h1><form><input placeholder="Visible query"><div id="extra" class="extra"><input placeholder="Optional query"></div><button type="button" onclick="this.textContent='收起'">展开全部</button><button type="button" aria-expanded="false" onclick="document.querySelector('#extra').style.display='block';this.textContent='收起筛选 ⌃';this.setAttribute('aria-expanded','true')">展开筛选（还有13项）⌄</button><div class="custom" onclick="this.setAttribute('aria-expanded','true')">展开全部</div><span class="custom" onclick="this.textContent='收起筛选'">展开筛选（还有2项）</span><p>展开全部</p><div>展开全部<p>删除</p></div><button type="button">展开全部并删除</button><input hidden type="password" value="private-fixture-password"><input name="api_token" value="private-fixture-token"></form>`;
test('isolated row menu hover reveals read-only actions without authorizing unknown clicks',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'hover-')),server=http.createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end('<style>.options{display:none}.el-dropdown:hover .options{display:block}</style><h1>Users</h1><div class="el-dropdown" style="width:100px;height:50px">更多菜单<div class="options"><button>查看</button><button>删除</button></div></div>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const b=new WebsiteBrowser(dir,{launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP hover.test 127.0.0.1']})}),e={projectId:'people',tier:'prd',baseUrl:`http://hover.test:${server.address().port}/`},job={id:'hover-a'};
 t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});let s=await b.run(job,e,'connection');const menu=s.controls.find(c=>c.kind==='menu-trigger');assert.ok(menu);await assert.rejects(b.run(job,e,'browser_click',{ref:menu.ref}),e=>e.code==='BROWSER_CONTROL_TYPE');s=await b.run(job,e,'browser_hover',{ref:menu.ref});assert.ok(s.controls.some(c=>c.label==='查看'));assert.ok(!s.controls.some(c=>c.label==='删除'));
 const latestMenu=s.controls.find(c=>c.kind==='menu-trigger');await assert.rejects(b.run(job,e,'browser_key',{ref:latestMenu.ref,key:'Enter'}),e=>e.code==='BROWSER_CONTROL_TYPE');
 const handles=await pageHandles(b.pages.get(job.id).page),individual=[];for(const el of handles)individual.push(await el.evaluate(controlMetadata));
 assert.deepEqual(await b.pages.get(job.id).page.evaluate(controlMetadataBatch,{elements:handles}),individual);for(const el of handles)await el.dispose();
 const page=b.pages.get(job.id).page;await page.goto('about:blank');const diag=await b.run(job,e,'browser_diagnostics');assert.equal(diag.readOnly,true);assert.equal(page.url(),'about:blank');
});
const pageHandles=page=>page.locator('div,button').elementHandles();
for(const backend of ['isolated','shared'])test(`${backend}: dynamic and custom expansion controls, before/after inspection and safe stale refs`,async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'expansion-'));const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP expansion.test 127.0.0.1']})};const e={projectId:'warehouse',tier:'prd',baseUrl:`http://expansion.test:${server.address().port}/`},job={id:'expand-a'};let context,page;
 const b=backend==='isolated'?new WebsiteBrowser(dir,driver):new SharedChromeBrowser(async()=>true,async q=>{if(q.operation==='find')return {tabId:'1',windowId:'1'};return JSON.parse(await page.evaluate(q.script));},async()=>{});
 if(backend==='shared'){context=await driver.launchPersistentContext(dir,{args:[]});page=await context.newPage();await page.goto(e.baseUrl);}
 t.after(async()=>{await b.close();await context?.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});let s=await b.run(job,e,'connection');if(backend==='isolated')page=b.pages.get(job.id).page;
 assert.equal(s.controls.filter(c=>c.label==='展开全部').length,2);assert.ok(s.controls.some(c=>c.label==='展开筛选（还有13项）⌄'));assert.equal(s.controls.some(c=>/删除/.test(c.label)),false);
 const expanded=s.controls.find(c=>c.label==='展开筛选（还有13项）⌄');const before=await b.run(job,e,'browser_inspect',{ref:expanded.ref});assert.deepEqual(before.scopeFields,{total:2,visible:1});assert.doesNotMatch(JSON.stringify(before),/private-fixture|api_token/);assert.equal(before.chain[0].expanded,'false');
 s=await b.run(job,e,'browser_click',{ref:expanded.ref});const after=await b.run(job,e,'browser_inspect',{ref:s.controls.find(c=>c.label==='收起筛选 ⌃').ref});assert.deepEqual(after.scopeFields,{total:2,visible:2});assert.equal(after.chain[0].expanded,'true');
 await assert.rejects(b.run(job,e,'browser_inspect',{ref:expanded.ref}));const ref=s.controls.find(c=>c.label==='展开全部').ref;await page.evaluate(()=>document.querySelector('button').textContent='删除');await assert.rejects(b.run(job,e,'browser_inspect',{ref}));
 if(backend==='isolated'){const other=await b.run({id:'expand-b'}, {...e,projectId:'orders',tier:'uat'},'connection');assert.ok(other.controls.some(c=>c.label.includes('还有13项')));await assert.rejects(b.run({id:'expand-b'},{...e,projectId:'orders',tier:'uat'},'browser_inspect',{ref:s.controls[0].ref}));}
});
test('inspection has an actual scoped tool entry, no selectors/scripts/URLs and no native cloud-sheet exposure',()=>{
 assert.ok(websiteTools({id:'x'},{}).spec.some(x=>x.tool==='browser_inspect'));assert.equal(websiteTools({environmentAccess:{websiteTarget:'https://example.feishu.cn/sheets/shtcExample'}},{}).spec.some(x=>x.tool==='browser_inspect'),false);
 validateBrowserTool('browser_inspect',{ref:'current'});for(const args of [{ref:'x',selector:'body'},{ref:'x',url:'https://other.test'},{ref:'x',js:'return window.token'},{ref:1}])assert.throws(()=>validateBrowserTool('browser_inspect',args));
});
