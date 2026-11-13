import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';
import {websitePageLocation,websitePageRoute,validateBrowserTool} from '../src/shared/browser-tool-input.js';
test('route diagnostics distinguish redaction from absent parameters and hash from history without values',()=>{
 for(const prefix of ['https://a.test/report?','https://a.test/#/report?']){
  const url=prefix+'debug=private-value&object=other-value&token=secret&password=secret';
  const route=websitePageRoute(url);assert.deepEqual(route.mode==='hash'?route.hashQueryKeys:route.queryKeys,['debug','object']);
  assert.doesNotMatch(JSON.stringify([route,websitePageLocation(url)]),/private-value|other-value|secret|password|token/);
 }
 assert.deepEqual(websitePageRoute('https://a.test/page').queryKeys,[]);
 assert.throws(()=>validateBrowserTool('browser_navigate',{url:'https://a.test',js:'evil'}));
});
test('isolated browser corrects history/hash routing in place, preserves target on blank recovery and isolates systems',async t=>{
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');const u=new URL(req.url,'http://fixture');res.end(`<h1>${u.pathname==='/report'&&u.searchParams.has('debug')?'Request parameters verified':'Home shell'}</h1><button>查询</button><button>保存</button>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=await mkdtemp(path.join(os.tmpdir(),'route-continue-')),b=new WebsiteBrowser(dir,{launchPersistentContext:(p,o)=>chromium.launchPersistentContext(p,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP first.test 127.0.0.1, MAP second.test 127.0.0.1']})});
 t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'first',tier:'prd',baseUrl:`http://first.test:${server.address().port}/`},j={id:'a',environmentAccess:{websiteTarget:e.baseUrl+'#/report?debug=1'}};
 let r=await b.run(j,e,'connection');assert.match(r.pageText,/Home shell/);const page=b.pages.get(j.id).page,old=r.controls[0].ref;
 r=await b.run(j,e,'browser_navigate',{url:e.baseUrl+'report?debug=1'});assert.equal(b.pages.get(j.id).page,page);assert.match(r.pageText,/Request parameters verified/);assert.equal(r.route.mode,'history');assert.deepEqual(r.route.queryKeys,['debug']);assert.equal(r.navigation.targetMatched,true);assert.doesNotMatch(r.url,/debug/);
 await assert.rejects(b.run(j,e,'browser_click',{ref:old}));
 await page.goto('about:blank');r=await b.run(j,e,'browser_recover');assert.match(r.pageText,/Request parameters verified/);assert.equal(new URL(page.url()).searchParams.get('debug'),'1');
 for(const url of ['https://other.test/report',e.baseUrl+'delete',e.baseUrl+'report?token=secret'])await assert.rejects(b.run(j,e,'browser_navigate',{url}),e=>e.code==='BROWSER_ARGUMENTS');
 const second=await b.run({id:'b'},{...e,projectId:'second',tier:'uat',baseUrl:`http://second.test:${server.address().port}/`},'connection');assert.match(second.pageText,/Home shell/);assert.match((await b.run(j,e,'browser_snapshot')).pageText,/Request parameters verified/);
});
test('daily Chrome binds explicit deep targets on first, resumed and changed plans without resetting ordinary progress',async()=>{
 const calls=[],b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);if(q.operation==='find')return{tabId:'one',windowId:'1'};if(q.script==='JSON.stringify({blank:location.href==="about:blank"})')return{blank:false};return{pageText:'ready',controls:[]};},async()=>{});
 const e={projectId:'demo',tier:'prd',baseUrl:'https://app.test/app/'},base={questionId:'q',originProfile:'bot',projectId:'demo'},j={...base,id:'a',environmentAccess:{websiteTarget:e.baseUrl+'report?debug=1'}};
 const navigations=()=>calls.filter(q=>q.script?.includes('location.assign'));
 await b.run(j,e,'connection');assert.equal(navigations().length,1);await b.run(j,e,'browser_snapshot');assert.equal(navigations().length,1);
 await b.release('a');await b.run({...j,id:'b',environmentAccess:{websiteTarget:e.baseUrl+'detail?id=2'}},e,'connection');assert.equal(navigations().length,2);
 const revised={...j,id:'b',environmentAccess:{websiteTarget:e.baseUrl+'detail?id=3'}};await b.run(revised,e,'connection');assert.equal(navigations().length,3);
 await b.run(revised,e,'browser_navigate',{url:e.baseUrl+'report?debug=1'});assert.equal(navigations().length,4);await b.run(revised,e,'browser_snapshot');assert.equal(navigations().length,4);
 await assert.rejects(b.run(revised,e,'browser_navigate',{url:'https://app.test/other/'}));await assert.rejects(b.run(revised,e,'browser_navigate',{url:e.baseUrl+'save'}));assert.equal(navigations().length,4);
});
test('daily Chrome explicit target requires fresh authorization before navigation',async()=>{
 const calls=[],b=new SharedChromeBrowser(async(_j,_w,r)=>!r.url().includes('?debug'),async q=>{calls.push(q);return{tabId:'1',windowId:'1'};},async()=>{});
 await assert.rejects(b.run({id:'a',environmentAccess:{websiteTarget:'https://app.test/report?debug=1'}},{baseUrl:'https://app.test/'},'connection'),/授权/);assert.equal(calls.some(q=>q.script?.includes('location.assign')),false);
});

test('daily Chrome fixed navigation and route metadata execute in a real browser and reject a hijacked origin',async t=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage();t.after(()=>browser.close());await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<h1>Business report</h1>'}));await page.goto('https://app.test/app/');
 const b=new SharedChromeBrowser(async()=>true,async q=>q.operation==='find'?{tabId:'1',windowId:'1'}:JSON.parse(await page.evaluate(q.script)),async()=>page.waitForTimeout(50));
 const e={projectId:'first',tier:'prd',baseUrl:'https://app.test/app/'},j={id:'j',originProfile:'bot',projectId:'first',environmentAccess:{websiteTarget:e.baseUrl+'report?debug=1'}};
 let r=await b.run(j,e,'connection');assert.deepEqual(r.route.queryKeys,['debug']);assert.equal(r.url,e.baseUrl+'report');assert.match(r.pageText,/Business report/);
 r=await b.run(j,e,'browser_navigate',{url:e.baseUrl+'#/report?object=private'});assert.deepEqual(r.route.hashQueryKeys,['object']);assert.doesNotMatch(JSON.stringify(r),/object=private/);
 await assert.rejects(b.run({...j,originProfile:'other'},e,'browser_snapshot'),/入口已变化/);
 await page.goto('https://foreign.test/');await assert.rejects(b.run(j,e,'browser_navigate',{url:e.baseUrl+'report'}),/离开授权应用/);assert.equal(new URL(page.url()).origin,'https://foreign.test');
});
