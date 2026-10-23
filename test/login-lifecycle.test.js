import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {browserLoginState,authResponseState} from '../src/shared/browser-login-state.js';
import {authorizeWebsiteRequest,renewWaitingWebsitePlan} from '../src/control-plane/website-authorization.js';
import {planQuery} from '../src/shared/environment-access.js';import {JsonStore} from '../src/shared/store.js';
const entry=baseUrl=>({kind:'website',tier:'uat',projectId:'demo',baseUrl,credentialRef:'test',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',browser:true,reviewed:true,description:'view',parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,timeoutMs:1000}}});
const cfg=e=>({version:1,environments:{web:e}}),query={environmentId:'web',queryId:'investigate',parameters:['read']},actor={profile:'owner',senderId:'ou_admin'};
test('auth response classification retains categories only and distinguishes rejection and human steps',()=>{
 assert.equal(authResponseState(200,{RESPONSE:{RETURN_DATA:{resCode:'error',msg:'密码错误 secret-value'}}}).credentialRejected,true);
 assert.equal(authResponseState(200,{data:{forceChangePassword:true}}).passwordChangeRequired,true);
 assert.equal(authResponseState(200,{message:'captcha verification code'}).verificationRequired,true);
 assert.equal(authResponseState(200,{success:true,token:'never-return'}),null);
 assert.equal(authResponseState(503,{}).serviceUnavailable,true);assert.equal(authResponseState(404,{}).requestFailed,true);assert.equal(authResponseState(429,{}).rateLimited,true);
 assert.doesNotMatch(JSON.stringify(authResponseState(401,{password:'secret-value'})),/secret-value|password/);
});
test('DOM probe never treats blank/loading or password change as authenticated and does not expose input values',async t=>{
 const b=await chromium.launch({headless:true});t.after(()=>b.close());const p=await b.newPage();
 await p.setContent('<div id="app"></div>');assert.equal((await p.evaluate(browserLoginState)).pageReady,false);
 await p.setContent('<h1>新密码 确认密码</h1><input type=password value=secret><input type=password>');const s=await p.evaluate(browserLoginState);assert.equal(s.passwordChangeRequired,true);assert.equal(s.pageReady,false);assert.doesNotMatch(JSON.stringify(s),/secret/);
 await p.setContent('<h1>订单首页</h1><nav>订单查询</nav>');assert.equal((await p.evaluate(browserLoginState)).pageReady,true);
});
test('expired login scopes renew only their unchanged signed read grant; changed config and tampering are rejected',async t=>{
 const d=await mkdtemp(path.join(os.tmpdir(),'login-scope-'));t.after(()=>rm(d,{recursive:true,force:true}));const store=new JsonStore(path.join(d,'state.json')),e=entry('https://site.example/'),c=cfg(e);
 const plan=planQuery(c,query,'demo',actor,Date.now()-3600000);const job={id:'j',projectId:'demo',sourceEnvironment:'sit',senderId:'ou_admin',originProfile:'owner',status:'awaiting_clarification',result:{browserLoginRequired:true},environmentAccess:plan,events:[]};await store.transact(s=>s.jobs.push(job));
 const context={store,projects:{projects:{demo:{analysisEnvironments:{sit:{runtimeTier:'uat'}}}}}};
 const [a,b]=await Promise.all([renewWaitingWebsitePlan(context,job,c),renewWaitingWebsitePlan(context,job,c)]);assert.equal(a.environmentAccess.scopeHash,b.environmentAccess.scopeHash);assert.ok(Date.parse(a.environmentAccess.expiresAt)>Date.now());assert.equal(a.senderId,job.senderId);assert.equal(a.environmentAccess.environmentId,'web');
 await assert.rejects(()=>renewWaitingWebsitePlan(context,{...job,environmentAccess:{...plan,scopeHash:'tampered'}},c));
 await assert.rejects(()=>renewWaitingWebsitePlan(context,job,cfg({...e,baseUrl:'https://other.example/'})));
});
test('real isolated browser submits spaced login button, completes read-only bootstrap while waiting and reports rejection',async t=>{
 const d=await mkdtemp(path.join(os.tmpdir(),'login-bootstrap-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(d,'env.json');let reject=false,posts=0,bootstrap=0,writes=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/login'&&req.method==='POST'){posts++;res.setHeader('content-type','application/json');if(reject){res.end(JSON.stringify({success:false,message:'密码错误'}));return;}res.setHeader('set-cookie','session=fixture; Path=/');res.end('{"success":true}');return;}
  if(req.url==='/getProfile'){bootstrap++;res.setHeader('content-type','application/json');res.end('{"ok":true}');return;}
  if(req.url==='/save'){writes++;res.end('bad');return;}
  if(req.url==='/app'){res.writeHead(302,{location:'/login'});res.end();return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.end(`<form><input name="username" placeholder="用户名"><input type="password"><button type="button" onclick="fetch('/login',{method:'POST',body:'fixture'}).then(r=>r.json()).then(async r=>{if(!r.success){document.querySelector('#error').innerText='密码错误';return;}await fetch('/getProfile');document.body.innerHTML='<h1>订单首页</h1>';history.replaceState(null,'','/home')})">登 录</button><div id="error" role="alert"></div></form>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const e=entry(`http://login-fixture.test:${server.address().port}/app`),config=cfg(e);await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(config));const store=new JsonStore(path.join(d,'state.json'));const plan=planQuery(config,query,'demo',actor);const job={id:'j',projectId:'demo',originProfile:'owner',senderId:'ou_admin',environmentAccess:plan,status:'awaiting_clarification',result:{browserLoginRequired:true},events:[]};await store.transact(s=>s.jobs.push(job));
 const driver={launchPersistentContext:(dir,opts)=>chromium.launchPersistentContext(dir,{...opts,headless:true,args:[...opts.args,'--no-proxy-server','--host-resolver-rules=MAP login-fixture.test 127.0.0.1']})};
 const browser=new WebsiteBrowser(d,driver,(...args)=>authorizeWebsiteRequest({store},...args));t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(d,{recursive:true,force:true});});
 assert.equal((await browser.run(job,e,'connection')).loginRequired,true);const result=await browser.submitCredentials(job,e,{username:'fixture-user',password:'fixture-password'});assert.equal(result.authenticated,true);assert.equal(posts,1);assert.equal(bootstrap,1);assert.equal(await browser.loginReady(job,e),true);
 await browser.pages.get('j').page.evaluate(()=>fetch('/save',{method:'POST'}).catch(()=>{}));assert.equal(writes,0);
 await browser.pages.get('j').page.goto(e.baseUrl);reject=true;const denied=await browser.submitCredentials(job,e,{username:'fixture-user',password:'fixture-password'},{force:true});assert.equal(denied.authenticated,false);assert.equal(denied.credentialRejected,true);assert.equal(posts,2);assert.doesNotMatch(JSON.stringify(denied),/fixture-user|fixture-password/);
 const page=browser.pages.get('j').page;
 await page.setContent('<form><input name="username"><input type="password"><input placeholder="验证码"><button type="button">登 录</button></form>');
 const verification=await browser.submitCredentials(job,e,{username:'fixture-user',password:'fixture-password'},{force:true});assert.equal(verification.verificationRequired,true);assert.equal(verification.attempted,false);assert.equal(await page.locator('input[type=password]').inputValue(),'fixture-password');assert.equal(posts,2);
 await page.setContent('<h1>新密码 确认密码</h1><input type=password><input type=password>');
 const change=await browser.submitCredentials(job,e,{username:'fixture-user',password:'fixture-password'},{force:true});assert.equal(change.passwordChangeRequired,true);assert.equal(await page.locator('input[type=password]').first().inputValue(),'');
 await page.setContent('<form><input name="username"><input type=password></form>');
 const unconfirmed=await browser.submitCredentials(job,e,{username:'fixture-user',password:'fixture-password'},{force:true});assert.equal(unconfirmed.submissionUnconfirmed,true);assert.equal(posts,2);
 await assert.rejects(()=>browser.submitCredentials(job,{...e,baseUrl:'https://other.example/'},{username:'fixture-user',password:'fixture-password'},{force:true}),/范围/);

});
