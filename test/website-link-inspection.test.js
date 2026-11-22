import test from'node:test';import assert from'node:assert/strict';import http from'node:http';import{mkdtemp,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{chromium}from'playwright';import{WebsiteBrowser}from'../src/control-plane/website-browser.js';import{correctableBrowserCodes}from'../src/shared/browser-tool-input.js';
test('visible external read links explain their target without following or disclosing query values; other reads continue',async t=>{let queries=0,external=0;const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.url==='/get'){queries++;res.end('{}');return;}res.end('<h1>已登录</h1><a target="_blank" href="https://files.example.test/reports/notice.pdf?token=secret-value&amp;id=123">查看</a><button onclick="fetch(\'/get\')">查询</button>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(path.join(os.tmpdir(),'web-link-')),base='http://agentos-fixture.test:'+server.address().port,driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})},b=new WebsiteBrowser(dir,driver,async()=>true,{publicFetch:async()=>{external++;throw Error('Must not fetch external file');}});t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});const e={projectId:'other-system',tier:'uat',baseUrl:base+'/page'},j={id:'one'};let snap=await b.run(j,e,'connection'),ref=snap.controls.find(x=>x.label==='查看').ref;const inspected=await b.run(j,e,'browser_inspect',{ref});assert.deepEqual(inspected.link,{origin:'https://files.example.test',path:'/reports/notice.pdf',target:'_blank',crossOrigin:true,queryKeys:['id'],queryValuesRedacted:true,followed:false});assert.doesNotMatch(JSON.stringify(inspected),/secret-value|123/);await assert.rejects(b.run(j,e,'browser_click',{ref}),err=>err.code==='BROWSER_NAVIGATION_SCOPE'&&err.statusCode===400&&correctableBrowserCodes.has(err.code));assert.equal(external,0);snap=await b.run(j,e,'browser_snapshot');assert.equal(snap.url,base+'/page');await b.run(j,e,'browser_click',{ref:snap.controls.find(x=>x.label==='查询').ref});assert.equal(queries,1);});

test('reviewed visible PDF links use a separate GET and preserve the application page',async t=>{
 const server=http.createServer((_,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(
  '<h1>已登录</h1><a target="_blank" href="https://files.example.test/notices/example.pdf">查看通知</a>'+
  '<a href="https://files.example.test/notices/redirect.pdf">查看另一份</a>'+
  '<a href="https://files.example.test/other/notice.pdf">查看其它目录</a>'+
  '<a href="https://files.example.test/notices/copy.pdf?token=signed">查看签名附件</a>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(path.join(os.tmpdir(),'web-pdf-'));
 const base='http://agentos-fixture.test:'+server.address().port;
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})};
 const fetched=[];
 const b=new WebsiteBrowser(dir,driver,async()=>true,{publicFetch:async(url,init)=>{
  fetched.push({url,method:init.method,redirect:init.redirect,headers:init.headers});
  if(url.endsWith('/redirect.pdf'))return new Response(null,{status:302,headers:{location:'https://external.example.test/next.pdf'}});
  return new Response('%PDF-1.4\n%%EOF\n',{headers:{'content-type':'application/pdf'}});
 }});
 t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const environment={projectId:'other-system',tier:'uat',baseUrl:base+'/page',queries:{inspect:{pdfAttachmentRoots:['https://files.example.test/notices/']}}};
 const job={id:'pdf-test',environmentAccess:{queryId:'inspect'}};
 let snap=await b.run(job,environment,'connection');
 const ref=label=>snap.controls.find(c=>c.label===label).ref;
 const oldRef=ref('查看通知');
 await b.pages.get(job.id).page.locator('a').first().evaluate(el=>{el.href='https://files.example.test/notices/changed.pdf';});
 await assert.rejects(b.run(job,environment,'browser_click',{ref:oldRef}),error=>error.code==='BROWSER_CONTROL_CHANGED');
 snap=await b.run(job,environment,'browser_snapshot');
 for(const label of ['查看其它目录','查看签名附件'])await assert.rejects(b.run(job,environment,'browser_click',{ref:ref(label)}),error=>error.code==='BROWSER_NAVIGATION_SCOPE');
 await assert.rejects(b.run(job,environment,'browser_click',{ref:ref('查看另一份')}),error=>error.code==='BROWSER_ATTACHMENT_UNAVAILABLE');
 const result=await b.run(job,environment,'browser_click',{ref:ref('查看通知')});
 assert.equal(result.url,base+'/page');
 assert.equal(result.attachmentPreview.status,'verified_pdf');
 assert.match(result.attachmentPreview.file,/^website-pdf-[^/]+\/source\.pdf$/);
 assert.deepEqual(fetched,[
  {url:'https://files.example.test/notices/redirect.pdf',method:'GET',redirect:'manual',headers:undefined},
  {url:'https://files.example.test/notices/changed.pdf',method:'GET',redirect:'manual',headers:undefined},
 ]);
});
