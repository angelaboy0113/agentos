import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';
import {chromePage} from '../src/control-plane/chrome-page.js';
import {chromeLoginPage} from '../src/control-plane/chrome-login-page.js';
import {failureDiagnostic} from '../src/shared/failure-diagnostic.js';
const e={baseUrl:'https://business.example/app/',projectId:'p',tier:'uat'};
test('daily Chrome reuses scoped tabs with per-job locks and rechecks authorization; never closes user tabs',async()=>{
 const calls=[];let permitted=true;
 const b=new SharedChromeBrowser(async()=>permitted,async q=>{calls.push(q);if(q.operation==='execute')assert.match(q.script,/^JSON.stringify/);return q.operation==='find'?{tabId:String(calls.length),windowId:'1'}:{pageText:'Page password=hidden',controls:[]};});
 const r=await b.run({id:'a'},e,'connection');assert.doesNotMatch(r.pageText,/password=hidden/);
 await b.run({id:'a'},e,'browser_snapshot');assert.equal(calls.filter(x=>x.operation==='find').length,1);
 await b.run({id:'b'},e,'connection');assert.equal(calls.filter(x=>x.operation==='find')[1].exclude.length,1);
 permitted=false;const count=calls.length;await assert.rejects(b.run({id:'a'},e,'browser_snapshot'),/授权/);assert.equal(calls.length,count);
 await b.release('a');await b.close();assert.equal(calls.length,count);
});
test('daily Chrome exposes a safe automation health probe',async()=>{
 const calls=[];const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);return {ok:true,running:true,windows:1};});
 assert.deepEqual(await b.health(),{ok:true,running:true,windows:1});assert.equal(calls[0].operation,'health');
});
test('daily Chrome DOM reads rendered text and rejects stale refs, writes and foreign navigation',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<ul role="menu"><li><div class="ant-menu-submenu-title">预算管理</div></li></ul><h1>Actual page</h1><noscript>Enable JavaScript</noscript><div hidden>Hidden secret</div><input type=password value=secret style="display:none"><input placeholder="查询编号"><button onclick="document.querySelector('h1').textContent='Query done'">查询</button><button>保存</button><a href="https://other.example/">Other</a><a href="/app/detail">详情</a>`}));
 await page.goto(e.baseUrl);const q={baseUrl:e.baseUrl,token:'one',tool:'browser_snapshot'};
 const read=()=>page.evaluate(chromePage,q);let r=await read();assert.match(r.pageText,/Actual page/);assert.doesNotMatch(r.pageText,/Enable JavaScript|Hidden secret|secret/);
 assert.equal(r.controls.some(c=>['保存','Other'].includes(c.label)),false);assert.ok(r.controls.some(c=>c.label==='预算管理'));
 const old=r.controls.find(c=>c.label==='查询').ref;await read();
 assert.ok((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref:old}})).error);
 // Snapshot refs are replaced, not shared across questions.
 assert.ok((await page.evaluate(chromePage,{...q,token:'other',tool:'browser_click',args:{ref:old}})).error);
 r=await read();const ref=r.controls.find(c=>c.label==='查询').ref;
 assert.equal((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref}})).acted,true);
 assert.match((await read()).pageText,/Query done/);
 await page.goto('https://other.example/');assert.ok((await read()).error);
});
test('daily Chrome login status is detected without reading password; native bridge errors are explicit',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<input type=password value="private">'}));await page.goto(e.baseUrl);
 const r=await page.evaluate(chromePage,{baseUrl:e.baseUrl,token:'one',tool:'browser_snapshot'});assert.equal(r.loginRequired,true);assert.doesNotMatch(JSON.stringify(r),/private/);
 assert.match(failureDiagnostic(new Error('通过 AppleScript 执行 JavaScript 的功能已关闭')),/BROWSER_BRIDGE/);
});
test('fixed daily Chrome login program fills only the scoped login form',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<form><input name="username"><input type="password"><button type="submit" onclick="event.preventDefault();document.body.dataset.login=this.form.username.value+\':\'+this.form.querySelector(\'input[type=password]\').value">登录</button></form>'}));
 await page.goto(e.baseUrl);const result=await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'});
 assert.equal(result.submitted,true);assert.equal(await page.locator('body').getAttribute('data-login'),'alice:private-value');
 await page.goto('https://other.example/');assert.ok((await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'})).error);
});
test('fixed login program keeps same-origin verification pages waiting instead of claiming success',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>请输入短信验证码</h1><input name="otp">'}));
 await page.goto('https://business.example/login');const result=await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'});
 assert.equal(result.loginRequired,true);assert.equal(result.verificationRequired,true);
});
