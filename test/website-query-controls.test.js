import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {validateBrowserTool} from '../src/shared/browser-tool-input.js';
import {fitToolResult,investigateEnvironment} from '../src/runner/environment-investigator.js';
import {planQuery} from '../src/shared/environment-access.js';

test('fixed browser keyboard/scroll arguments reject scripts and browser hotkeys',()=>{
 for(const key of ['Enter','Tab','Escape','ArrowDown','PageDown'])validateBrowserTool('browser_key',{ref:'current',key});
 validateBrowserTool('browser_key',{ref:'page',key:'Escape'});
 for(const direction of ['left','right','up','down'])validateBrowserTool('browser_scroll',{ref:'page',direction});
 for(const args of [{ref:'page',key:'Enter'},{ref:'current',key:'Control+L'},{ref:'current',key:'Meta+W'},{ref:'current',key:'Enter',script:'x'}])assert.throws(()=>validateBrowserTool('browser_key',args));
 assert.throws(()=>validateBrowserTool('browser_scroll',{ref:'page',direction:'javascript:evil'}));
});

test('real query UI supports calendars, more filters, status options, pagination, dismiss and readonly values',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'query-controls-'));let writes=0;
 const server=http.createServer((req,res)=>{if(req.url==='/save'){writes++;res.end('{}');return;}res.setHeader('content-type','text/html;charset=utf-8');res.end(`<h1>另一个业务系统</h1>
 <div role="tab"><div class="el-collapse-item__header" role="button" onclick="document.querySelector('#filters').hidden=false">更多</div></div><span onclick="document.querySelector('#filters').hidden=false">更多筛选</span><div id="filters" hidden>
 <div class="el-date-editor"><input id="date" placeholder="创建时间" onclick="document.querySelector('#calendar').hidden=false"></div>
 <div class="el-picker-panel" id="calendar" hidden><div class="el-date-picker__header">2026 年 10 月</div><button class="el-picker-panel__icon-btn el-icon-arrow-left" onclick="document.querySelector('#calendar .el-date-picker__header').textContent='2026 年 9 月'"></button><table class="el-date-picker"><tr><td class="available" onclick="document.querySelector('#date').value='2026-09-23';document.querySelector('#calendar').hidden=true"><span>23</span></td></tr></table></div>
 <div class="el-select"><input readonly placeholder="订单状态" onclick="document.querySelector('#options').hidden=false"></div><ul id="options" hidden><li class="el-select-dropdown__item" onclick="document.querySelector('#status').textContent=this.textContent;document.querySelector('#options').hidden=true">已审批</li></ul><div id="status"></div>
 <button onclick="document.querySelector('#status').textContent+='已查询'">查询</button></div>
 <div class="el-pagination"><li onclick="document.querySelector('#pagenum').textContent='2'">2</li><button aria-label="下一页" onclick="document.querySelector('#pagenum').textContent='3'"></button><input placeholder="前往页码" onkeydown="if(event.key==='Enter')document.querySelector('#pagenum').textContent=this.value"></div><div id="pagenum">1</div>
 <button onclick="document.querySelector('#detail').hidden=false">查看</button><div class="el-dialog" id="detail" hidden><button class="el-dialog__headerbtn" onclick="document.querySelector('#detail').hidden=true"></button><div class="el-col"><span>订单号：</span><input readonly value="SO-001"></div><div class="el-col"><span>订单总价：</span><input disabled value="1199"></div><input type="password" hidden value="secret-value"><input name="api_token" value="secret-token"><div data-sensitive><input value="secret-region"></div><button onclick="fetch('/save',{method:'POST'})">提交审批</button></div>
 <button onclick="fetch('/save',{method:'POST'})">删除</button><button onclick="fetch('/save',{method:'POST'})">创建订单</button>
 <div id="scroll" style="width:100px;overflow:auto"><div style="width:1400px"><button>查看宽表</button></div></div>
 <script>document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#detail').hidden=true;document.querySelector('#calendar').hidden=true}})</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP fixture.test 127.0.0.1']})},browser=new WebsiteBrowser(dir,driver),job={id:'query-ui'},e={projectId:'generic-demo',tier:'uat',baseUrl:`http://fixture.test:${server.address().port}/`};
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 let snapshot=await browser.run(job,e,'connection');const page=browser.pages.get(job.id).page;
 const click=async label=>{const c=snapshot.controls.find(c=>c.label===label);assert.ok(c,`missing ${label}`);snapshot=await browser.run(job,e,'browser_click',{ref:c.ref});};
 assert.equal(snapshot.controls.some(c=>/删除|创建订单/.test(c.label)),false);
 assert.equal(snapshot.controls.filter(c=>c.label==='展开面板：更多').length,1);assert.ok(snapshot.controls.find(c=>c.label==='更多筛选'));await click('展开面板：更多');await click('创建时间');await click('上个月');assert.ok(snapshot.controls.some(c=>/日期选择：2026 年 9 月 23/.test(c.label)));
 await click(snapshot.controls.find(c=>c.kind==='calendar'&&c.label.includes('23')).label);assert.equal(snapshot.fields.find(f=>f.label==='创建时间').value,'2026-09-23');
 await click('订单状态');await click('已审批');await click('查询');assert.match(snapshot.pageText,/已审批已查询/);
 await click('2');assert.equal(await page.locator('#pagenum').textContent(),'2');await click('下一页');assert.equal(await page.locator('#pagenum').textContent(),'3');
 snapshot=await browser.run(job,e,'browser_search',{ref:snapshot.controls.find(c=>c.label==='前往页码').ref,text:'7'});snapshot=await browser.run(job,e,'browser_key',{ref:snapshot.controls.find(c=>c.label==='前往页码').ref,key:'Enter'});assert.equal(await page.locator('#pagenum').textContent(),'7');
 await click('查看');assert.equal(snapshot.fields.find(f=>f.label==='订单号：').value,'SO-001');assert.equal(snapshot.fields.find(f=>f.label==='订单总价：').value,'1199');assert.equal(JSON.stringify(snapshot).includes('secret-'),false);assert.equal(snapshot.controls.some(c=>c.label==='提交审批'),false);
 await click('关闭当前弹窗');assert.equal(await page.locator('#detail').isVisible(),false);await click('查看');snapshot=await browser.run(job,e,'browser_key',{ref:'page',key:'Escape'});assert.equal(await page.locator('#detail').isVisible(),false);
 snapshot=await browser.run(job,e,'browser_scroll',{ref:snapshot.controls.find(c=>c.label==='查看宽表').ref,direction:'right'});assert.ok(await page.locator('#scroll').evaluate(e=>e.scrollLeft)>0);
 await page.evaluate(()=>fetch('/save',{method:'POST'}).catch(()=>{}));assert.equal(writes,0);
 const stale=snapshot.controls[0].ref;await browser.run(job,e,'browser_snapshot');await assert.rejects(browser.run(job,e,'browser_key',{ref:stale,key:'Enter'}),error=>error.code==='BROWSER_REF_STALE');
});

test('large business fields compact with explicit incomplete evidence marker',()=>{
 const result=fitToolResult({pageText:'业务页面'.repeat(3000),controls:[{ref:'one',label:'查询'}],fields:Array.from({length:100},(_,n)=>({label:'字段'+n,value:'中'.repeat(500)}))});
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=24000);assert.equal(result.fieldsLimited,true);assert.ok(result.fields.length>0);assert.equal(result.resultLimited,true);
});

test('website progress uses actual page/field evidence and ignores regenerated ref IDs',async()=>{
 const cfg={version:1,environments:{web:{kind:'website',projectId:'demo',tier:'uat',baseUrl:'https://example.test/',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'网页',maxRows:10,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]}}}}};
 const plan=planQuery(cfg,{environmentId:'web',queryId:'investigate',parameters:['核对详情']},'demo',{profile:'owner',senderId:'ou_member'});
 const run=async(value,ref)=>{let n=0;return investigateEnvironment(plan,async()=>{},{load:async()=>cfg,tools:async()=>({spec:[{tool:'connection'},{tool:'browser_snapshot'}],run:async()=>({url:'https://example.test/',pageText:'详情',fields:[{label:'总价',value}],controls:[{ref,label:'查看'}],rows:[]}),close:async()=>{}}),planner:async()=>({next:async()=>++n===1?{tool:'browser_snapshot',arguments:'{}'}:{tool:'finish',summary:'已核对',complete:true},close:async()=>{}})});};
 const first=await run('1199','one'),same=await run('1199','two'),changed=await run('1200','three');
 assert.ok(first.evidence.businessProgressHash);assert.equal(first.evidence.businessProgressHash,same.evidence.businessProgressHash);assert.notEqual(first.evidence.businessProgressHash,changed.evidence.businessProgressHash);
});
