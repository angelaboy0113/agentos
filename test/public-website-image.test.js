import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {isPublicImageAddress, passivePublicImage, fetchPassivePublicImage} from '../src/control-plane/public-website-image.js';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';

test('public media stays limited to images from the current business frame',()=>{
 const page='https://app.test/report',r={url:'https://cdn.test/store/photo.jpg',method:'GET',resourceType:'image'};
 assert(passivePublicImage(r,page,page));
 for(const delta of [{method:'POST'},{resourceType:'fetch'},{resourceType:'script'},{url:r.url+'?token=secret'},
  {url:r.url.replace('.jpg','.svg')},{url:'http://cdn.test/photo.jpg'},{url:'https://app.test/photo.jpg'}]){
  assert(!passivePublicImage({...r,...delta},page,page));
 }
 assert(!passivePublicImage(r,'https://foreign.test',page));
 for(const a of ['::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::1','169.254.169.254',
  '127.0.0.1','192.168.1.2','172.16.1.2','10.0.0.1','100.100.100.200'])assert(!isPublicImageAddress(a),a);
 assert(isPublicImageAddress('8.8.8.8'));assert(isPublicImageAddress('2606:4700:4700::1111'));
});

test('resolved public destination is pinned and redirect is returned without a second request',async()=>{
 let connects=0;
 const connect=(url,opts,receive)=>{
  connects++;
  assert.equal(url.hostname,'cdn.test');assert.equal(opts.agent,false);assert.equal(opts.headers,undefined);
  opts.lookup('cdn.test',{},(_error,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  const client=new EventEmitter();
  client.end=()=>{const body=Readable.from([]);body.statusCode=302;receive(body);};
  return client;
 };
 const r=await fetchPassivePublicImage('https://cdn.test/a.png',{connect,resolve:async()=>[
  {address:'10.0.0.2',family:4},{address:'8.8.8.8',family:4}
 ]});
 assert.equal(r.status,302);
 await assert.rejects(fetchPassivePublicImage('https://cdn.test/a.png',{connect,resolve:async()=>[{address:'127.0.0.1',family:4}]}),/no public address/);
 assert.equal(connects,1);
});

test('two independently connected applications render public photos without any image configuration',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'public-images-'));
 const photo='https://photo.test/business/image.png';
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<h1>Business view</h1><img src="${photo}">`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP first-app.test 127.0.0.1, MAP second-app.test 127.0.0.1']})};
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const calls=[];
 const browser=new WebsiteBrowser(dir,driver,async()=>true,{passiveImageFetch:async(url,opts)=>{
  assert.equal(url,photo);assert.equal(opts.headers,undefined);calls.push(url);
  return new Response(pixel,{headers:{'content-type':'image/png','set-cookie':'ignored=yes'}});
 }});
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 for(const [projectId,tier,hostname] of [['first','prd','first-app.test'],['second','uat','second-app.test']]){
  const env={projectId,tier,baseUrl:`http://${hostname}:${server.address().port}/`,queries:{inspect:{}}};
  const job={id:projectId,environmentAccess:{queryId:'inspect'}};
  await browser.run(job,env,'connection');
  const {page,session}=browser.pages.get(job.id);
  await page.waitForFunction(()=>document.querySelector('img')?.complete);
  assert.equal(await page.locator('img').evaluate(el=>el.naturalWidth),1);
  assert.deepEqual(await session.context.cookies(),[]);
 }
 assert.equal(calls.length,2);
});

test('a previously reviewed image keeps its existing reader even when eligible for passive loading',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'reviewed-public-image-'));
 const photo='https://media.test/existing/photo.png';
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<h1>Business view</h1><img src="${photo}">`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP app-static.test 127.0.0.1']})};
 const calls=[];
 const browser=new WebsiteBrowser(dir,driver,async()=>true,{
  publicFetch:async url=>{calls.push(['reviewed',url]);return new Response(null,{status:403});},
  passiveImageFetch:async url=>{calls.push(['passive',url]);return new Response(null,{status:403});},
 });
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const env={projectId:'fixture',tier:'prd',baseUrl:`http://app-static.test:${server.address().port}/`,queries:{inspect:{staticResources:[photo]}}};
 await browser.run({id:'reviewed',environmentAccess:{queryId:'inspect'}},env,'connection');
 const {page}=browser.pages.get('reviewed');
 await page.waitForFunction(()=>document.querySelector('img')?.complete);
 assert.deepEqual(calls,[['reviewed',photo]]);
});
