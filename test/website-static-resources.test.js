import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import os from 'node:os';import path from 'node:path';import{mkdtemp,realpath,rm}from'node:fs/promises';import{chromium}from'playwright';
import{websiteStaticResourceAllowed as allow,validateWebsiteStaticResources as validate,validateWebsiteReadEndpoints,websiteRequestAllowed}from'../src/shared/website-policy.js';import{validateBrowserTool}from'../src/shared/browser-tool-input.js';import{WebsiteBrowser}from'../src/control-plane/website-browser.js';import{readWebsiteAsset}from'../src/control-plane/website-assets.js';
const cdn='https://cdn.example.test/static/framework.js';
test('QR authentication reads are parent-login-bound, GET-only and fixed-origin/path/type',async()=>{
 const {websiteLoginReadAllowed:login,validateWebsiteLoginReads:validate}=await import('../src/shared/website-policy.js');
 const rules=[{origin:'https://identity.example.test',path:'/connect/qrconnect',types:['document']},{origin:'https://identity.example.test',path:'/qrcode/',types:['image']}];validate(rules);
 const r={url:'https://identity.example.test/connect/qrconnect?state=opaque',method:'GET',resourceType:'document'};assert.ok(login(r,true,rules));assert.equal(login(r,false,rules),false);
 for(const change of [{method:'POST'},{resourceType:'fetch'},{url:r.url.replace('identity.','other.')},{url:'https://identity.example.test/connect/qrconnect/delete'},{url:'https://identity.example.test/qrcode/%2fsecret'}])assert.equal(login({...r,...change},true,rules),false);
 assert.ok(login({url:'https://identity.example.test/qrcode/opaque',method:'GET',resourceType:'image'},true,rules));
 assert.ok(login({...r,url:r.url+'&redirect_uri='+encodeURIComponent('https://app.test/login/callback')},true,rules,'https://app.test/'));
 assert.equal(login({...r,url:r.url+'&redirect_uri='+encodeURIComponent('https://foreign.test/callback')},true,rules,'https://app.test/'),false);
 for(const path of ['/','/../','/*/'])assert.throws(()=>validate([{...rules[0],path}]));
});
test('reviewed immutable CDN directories allow lazy chunks without APIs, credentials or query transport',async()=>{
 const {validateWebsiteStaticRoots:validateRoots}=await import('../src/shared/website-policy.js');
 const root='https://cdn.example.test/releases/build42/_next/static/';validateRoots([root]);
 const r={url:root+'chunks/pages/repo.js',method:'GET',resourceType:'script'};
 assert.ok(allow('https://app.test',r,[],[root]));
 const application='https://cdn.example.test/apps/product42/';assert.ok(allow('https://app.test',{...r,url:application+'new-version/static/chunk.js'},[],[application]));assert.equal(allow('https://app.test',{...r,url:application.replace('product42','product43')+'new-version/static/chunk.js'},[],[application]),false);
 for(const change of [{method:'POST'},{resourceType:'fetch'},{resourceType:'document'},{url:r.url+'?token=secret'},{url:root+'../../api/delete.js'},{url:root+'chunks/%2e%2e/private.js'},{url:root.replace('build42','build43')+'x.js'},{url:root+'x.json'}])assert.equal(allow('https://app.test',{...r,...change},[],[root]),false);
 for(const bad of ['https://cdn.example.test/','http://cdn.example.test/releases/build42/','https://cdn.example.test/releases/*/','https://cdn.example.test/releases/build42/?token=x'])assert.throws(()=>validateRoots([bad]));
});
test('exact public resources do not grant origin APIs, redirects, credentials, cross-method or cross-type reads',()=>{
 const origin='https://app.example.test',path='/api/encrypted/isEnableTransport',review=[{method:'GET',path,reviewed:true}];validateWebsiteReadEndpoints(review);assert.throws(()=>validateWebsiteReadEndpoints([{method:'POST',path,reviewed:true}]));assert.throws(()=>validateWebsiteReadEndpoints([{method:'GET',path:'/api/isDeleteAll',reviewed:true}]));assert.ok(websiteRequestAllowed(origin,{url:origin+path,method:'GET',resourceType:'fetch'},false,review));assert.equal(websiteRequestAllowed(origin,{url:origin+path,method:'GET',resourceType:'fetch'},false,[]),false);assert.equal(websiteRequestAllowed(origin,{url:origin+path,method:'POST',resourceType:'fetch'},false,review),false);assert.equal(websiteRequestAllowed(origin,{url:origin+'/api/isDeleteAll',method:'GET',resourceType:'fetch'},false,[{method:'GET',path:'/api/isDeleteAll',reviewed:true}]),false);validate([cdn]);const exact='http://app.example.test/lib/create-react-class.min.js';validate([exact],'http://app.example.test/');assert.ok(allow('http://app.example.test/',{url:exact,method:'GET',resourceType:'script'},[exact]));assert.equal(allow('http://app.example.test/',{url:exact,method:'POST',resourceType:'script'},[exact]),false);assert.equal(allow('http://app.example.test/',{url:exact,method:'GET',resourceType:'fetch'},[exact]),false);const r={url:cdn,method:'GET',resourceType:'script'};assert.ok(allow('https://app.example.test/',r,[cdn]));for(const change of [{url:cdn+'?token=x'},{method:'POST'},{resourceType:'fetch'},{resourceType:'document'},{url:'https://cdn.example.test/api/query'},{url:cdn.replace('cdn.','other.')}])assert.equal(allow('https://app.example.test/',{...r,...change},[cdn]),false);for(const value of [['https://u:p@cdn.example.test/a.js'],['https://cdn.example.test/a.js?x=1'],['http://cdn.example.test/a.js'],['https://localhost/a.js'],['https://cdn.example.test/api/query'],['https://cdn.example.test/*.js']])assert.throws(()=>validate(value));
});
test('real blank app reports static blocks and script errors, reviewed public dependency recovers without auth headers',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'static-ui-')),server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<script src="${cdn}" crossorigin="anonymous"></script><script>document.bodyText = Framework.label;document.addEventListener('DOMContentLoaded',()=>document.body.textContent=Framework.label)</script>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP app.test 127.0.0.1']})};const calls=[],b=new WebsiteBrowser(dir,driver,async()=>true,{publicFetch:async(url,options)=>{calls.push({url,options});return new Response('window.Framework={label:"Another system ready"}',{status:200,headers:{'content-type':'application/javascript','access-control-allow-origin':'*','set-cookie':'secret-cookie'}});}});t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});const e={projectId:'system-one',tier:'uat',baseUrl:`http://app.test:${server.address().port}/`,queries:{investigate:{}}},j={id:'one',environmentAccess:{queryId:'investigate'}};
 let s=await b.run(j,e,'connection');await b.pages.get(j.id).page.waitForTimeout(80);s=await b.run(j,e,'browser_snapshot');assert.equal(s.pageStatus,'loading');assert.deepEqual(s.diagnostic.blockedResources,[cdn]);assert.ok(s.diagnostic.pageErrorCategories.includes('ReferenceError'));assert.equal(calls.length,0);
 const reviewed={...e,projectId:'system-two',tier:'prd',queries:{investigate:{staticResources:[cdn]}}},other={id:'two',environmentAccess:{queryId:'investigate'}};s=await b.run(other,reviewed,'connection');await b.pages.get(other.id).page.waitForTimeout(80);s=await b.run(other,reviewed,'browser_snapshot');assert.match(s.pageText,/Another system ready/);assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.headers,undefined);assert.equal((await b.pages.get(other.id).session.context.cookies()).length,0);
});
test('deployed script graph is task-bound, redacted, cached and independent from repository commit',async()=>{
 const s={job:{id:'one'},waiting:false,environment:{baseUrl:'https://app.test/',queries:{investigate:{}}},page:{locator:()=>({evaluateAll:async()=>['https://app.test/assets/main.js']})}},calls=[];const get=async(url,options)=>{calls.push({url,options});return new Response(url.endsWith('main.js')?'import("./feature.js"); const token="private-test-token";':'const service="/orders/web/fba/page"',{status:200});};
 const list=await readWebsiteAsset(s,{},async()=>true,get);const first=await readWebsiteAsset(s,{ref:list.assets[0].ref,find:'feature'},async()=>true,get);assert.doesNotMatch(first.text,/private-test-token/);assert.equal(first.imports.length,1);assert.equal(calls.length,1);await readWebsiteAsset(s,{ref:list.assets[0].ref},async()=>true,get);assert.equal(calls.length,1);const part=await readWebsiteAsset(s,{ref:first.imports[0].ref},async()=>true,get);assert.match(part.text,/fba/);const filtered=await readWebsiteAsset(s,{ref:list.assets[0].ref,find:'unmatched'},async()=>true,get);assert.equal(filtered.importsTotal,1);assert.equal(filtered.importsFiltered,true);assert.deepEqual(filtered.imports,[]);await assert.rejects(readWebsiteAsset({...s,assets:new Map()},{ref:first.imports[0].ref},async()=>true,get));await assert.rejects(readWebsiteAsset(s,{ref:first.imports[0].ref},async()=>false,get));await assert.rejects(readWebsiteAsset(s,{ref:list.assets[0].ref,contentHash:'0'.repeat(64)},async()=>true,get));for(const args of [{url:'https://other.test/a.js'},{ref:'x',js:'evil'},{offset:0}])assert.throws(()=>validateBrowserTool('browser_assets',args));
});

test('reviewed versioned public roots support rotating hashes and encoded Next chunks without widening APIs',async()=>{
 const {validateWebsiteStaticRoots}=await import('../src/shared/website-policy.js'),roots=['https://cdn.example.test/monorepo/{hex}/{hex}/_next/static/'];validateWebsiteStaticRoots(roots);
 for(const version of ['016aafd3/9a3de22cd64db576','0abcdef0/1234567890abcdef']){
  const url='https://cdn.example.test/monorepo/'+version+'/_next/static/chunks/pages/%5B...slug%5D.js';assert.ok(allow('https://app.test',{url,method:'GET',resourceType:'script'},[],roots));
  for(const change of [{method:'POST'},{resourceType:'document'},{resourceType:'fetch'},{url:url+'?token=x'},{url:url.replace('cdn.example.test','other.test')},{url:url.replace('/_next/static/','/api/')},{url:url.replace('pages/','pages/%252e%252e/')},{url:url.replace('pages/','pages/%2fsecret/')}])assert.equal(allow('https://app.test',{url,method:'GET',resourceType:'script',...change},[],roots),false);
 }
 for(const url of ['https://cdn.example.test/monorepo/not-a-hash/12345678/_next/static/a.js','https://cdn.example.test/monorepo/12345678/12345678/_next/api/read.json'])assert.equal(allow('https://app.test',{url,method:'GET',resourceType:'script'},[],roots),false);
 for(const bad of ['https://cdn.example.test/{anything}/static/','https://cdn.example.test/product/*/static/','https://cdn.example.test/product/prefix{hex}/static/'])assert.throws(()=>validateWebsiteStaticRoots([bad]));
});

test('public worker script classified as other stays constrained to the reviewed directory and JS type',()=>{
 const roots=['https://cdn.example.test/product/{hex}/{hex}/'];const r={url:'https://cdn.example.test/product/12345678/abcdef01/worker.js',method:'GET',resourceType:'other'};assert.ok(allow('https://app.test',r,[],roots));
 for(const change of [{method:'POST'},{url:r.url+'?credential=x'},{url:r.url.replace('worker.js','records.json')},{url:r.url.replace('/product/','/api/')},{url:r.url.replace('cdn.example.test','foreign.test')},{resourceType:'document'},{resourceType:'fetch'}])assert.equal(allow('https://app.test',{...r,...change},[],roots),false);
});

test('image roots match rotating dates and only image requests under the configured path',async()=>{
 const {websiteImageResourceAllowed:images,validateWebsiteImageRoots:validateImages}=await import('../src/shared/website-policy.js');
 const roots=['https://photos.test/capture/{date}/facade/','https://another.test/archive/{compactDate}/'];validateImages(roots);
 const url='https://photos.test/capture/2026-11-20/facade/store%20photo.jpeg';
 const req={method:'GET',resourceType:'image',url};
 assert.equal(images(req,roots),true);
 assert.equal(images({...req,url:'https://another.test/archive/20251104/photo.png'},roots),true);
 for(const delta of [{method:'POST'},{resourceType:'script'},{resourceType:'fetch'}, {url:url+'?token=hidden'},
  {url:url.replace('2026-11-20','static')},{url:url.replace('facade/','other/')},{url:url.replace('store%20photo.jpeg','%252e%252e.jpg')},
  {url:url.replace('store%20photo.jpeg','../other.jpg')},{url:url.replace('.jpeg','.svg')},{url:url.replace('photos.test','unknown.test')}]){
  assert.equal(images({...req,...delta},roots),false);
 }
 for(const root of ['https://photos.test/','https://photos.test/{date}/','https://photos.test/*/','http://photos.test/photos/','https://photos.test/photos/../other/'])assert.throws(()=>validateImages([root]));
});

test('configured photo actually decodes and misleading MIME is rejected without forwarding headers',async t=>{
 const photo='https://photos.test/capture/2026-11-20/facade/store.png', blocked=photo.replace('store.png','no.png');
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'reviewed-images-'));
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<h1>store photos</h1><img id="photo" src="${photo}"><img id="bad" src="${blocked}">`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP image-app.test 127.0.0.1']})};
 const calls=[],b=new WebsiteBrowser(dir,driver,async()=>true,{publicFetch:async(url,options)=>{
  calls.push({url,options});
  return new Response(pixel,{headers:{'content-type':url===photo?'image/png':'text/html','set-cookie':'private=ignored'}});
 }});
 t.after(async()=>{await b.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'fixture',tier:'uat',baseUrl:`http://image-app.test:${server.address().port}/`,
  queries:{inspect:{imageResourceRoots:['https://photos.test/capture/{date}/facade/']}}};
 const job={id:'photo',environmentAccess:{queryId:'inspect'}};
 await b.run(job,e,'connection');
 const {page,session}=b.pages.get(job.id);
 await page.waitForFunction(()=>[...document.images].every(img=>img.complete));
 assert.equal(await page.locator('#photo').evaluate(img=>img.naturalWidth),1);
 assert.equal(await page.locator('#bad').evaluate(img=>img.naturalWidth),0);
 assert.equal(calls.length,2);
 assert.ok(calls.every(c=>c.options.redirect==='manual'&&!c.options.headers));
 assert.deepEqual(await session.context.cookies(),[]);
});
