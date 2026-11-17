import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {websiteApplication} from '../src/shared/website-application.js';
import {catalog,planQuery,loadEnvironments} from '../src/shared/environment-access.js';
import {prepareWebsiteQuery} from '../src/control-plane/website-query.js';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {WebsiteCredentialService} from '../src/control-plane/website-credentials.js';
const entry=(baseUrl,extra={})=>({kind:'website',projectId:'demo',tier:'uat',baseUrl,credentialRef:'saved-app',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'读页面',maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string',maxLength:200}],browser:true}},...extra});

test('only trusted application roots share credentials and bootstrap configuration across independent questions',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'app-identity-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});
 const root=entry('https://business.test/crm/',{applicationRoot:true});root.queries.investigate.readEndpoints=[{method:'POST',path:'/auth/permission',reviewed:true}];const cfg={version:1,environments:{trustedRoot:root,legacyPage:entry('https://business.test/crm/orders',{credentialRef:'old-deep-ref'})}};await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const context={projects:{ownerOpenIdsByProfile:{owner:['ou_admin']},projects:{}}};
 for(const question of ['first','second']){const request=await prepareWebsiteQuery(context,{projectId:'demo',sourceEnvironment:'sit',originProfile:'owner',questionId:question,context:[]},{url:'https://business.test/crm/orders',tier:'uat',purpose:'看订单'});assert.equal(request.environmentId,'trustedRoot');}
 const after=await loadEnvironments();assert.deepEqual(catalog(after,'demo').map(e=>e.environmentId),['trustedRoot']);assert.equal(planQuery(after,{environmentId:'legacyPage',queryId:'investigate',parameters:['read']},'demo',{profile:'owner',senderId:'ou_admin'}).environmentId,'trustedRoot');assert.equal(after.environments.trustedRoot.credentialRef,'saved-app');assert.equal(Object.keys(after.environments).length,2);assert.equal(after.environments.legacyPage.credentialRef,'old-deep-ref');
 for(const [project,tier,url]of [['other','uat','https://business.test/crm/orders'],['demo','prd','https://business.test/crm/orders'],['demo','uat','https://other.test/crm/orders'],['demo','uat','https://business.test/crm-other/orders'],['demo','uat','http://business.test/crm/orders']])assert.equal(websiteApplication(cfg,project,tier,url),null);
 delete root.applicationRoot;assert.equal(websiteApplication(cfg,'demo','uat','https://business.test/crm/orders'),null);
});

test('application roots choose most specific scope and reject ambiguous configuration',()=>{
 const cfg={environments:{outer:entry('https://site.test/app/',{applicationRoot:true}),inner:entry('https://site.test/app/reports/',{applicationRoot:true,credentialRef:'reports'})}};assert.equal(websiteApplication(cfg,'demo','uat','https://site.test/app/reports/details').environmentId,'inner');cfg.environments.duplicate={...cfg.environments.inner,baseUrl:'https://site.test/app/reports'};assert.throws(()=>websiteApplication(cfg,'demo','uat','https://site.test/app/reports/details'),/歧义/);
});

test('saved credentials are reused by a fresh service after restart without asking again, live sessions need no Keychain read',async()=>{
 let reads=0,submits=0;const e=entry('https://site.test/app/'),read=async ref=>{assert.equal(ref,'saved-app');reads++;return {username:'fixture-account',password:'fixture-password'};};let ready=false;
 const context={websiteBrowser:{loginStatusFor:async()=>({pageReady:ready}),submitCredentials:async(job,environment,value)=>{assert.equal(value.password,'fixture-password');submits++;ready=true;return {authenticated:true};}}};
 assert.equal(await new WebsiteCredentialService(context,{read}).autoLogin({id:'one'},e),true);assert.equal(reads,1);assert.equal(submits,1);
 assert.equal(await new WebsiteCredentialService(context,{read}).autoLogin({id:'other-question'},e),true);assert.equal(reads,1);ready=false;
 assert.equal(await new WebsiteCredentialService(context,{read}).autoLogin({id:'after-restart'},e),true);assert.equal(reads,2);assert.equal(submits,2);
 const locked=new WebsiteCredentialService({websiteBrowser:{submitCredentials:async()=>{throw new Error('not called');}}},{read:async()=>{throw new Error('locked');}});assert.deepEqual(await locked.recoverLogin({},e),{authenticated:false,credentialState:'unavailable'});
});


test('confirmed login readiness resets only the completed episode, enabling saved credentials at the next expiry',async()=>{
 const browser=new WebsiteBrowser('/private/tmp/unused-browser');let ready=true;const state={environment:{baseUrl:'https://application.fixture.test/'},page:{url:()=> 'https://application.fixture.test/',evaluate:async()=>({pageReady:ready,loginRequired:!ready,loginState:ready?'ready':'login_required'})},blockedLoginReads:new Set(),waiting:true,sawLogin:true,credentialAttempted:true,authResult:{loginState:'rejected'}};
 await browser.loginStatus(state);assert.equal(state.credentialAttempted,false);assert.equal(state.authResult,null);assert.equal(state.reloadAfterLogin,false);ready=false;state.credentialAttempted=true;await browser.loginStatus(state);assert.equal(state.credentialAttempted,true);
});


test('same-URL legacy entries route to the explicit application identity without merging privileges or old grants',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'same-url-app-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});
 const legacy=entry('https://logs.fixture.test/logs'),trusted=entry('https://logs.fixture.test/logs',{applicationRoot:true,credentialRef:'sso-app',loginNavigation:{interactive:true,remoteQr:true,steps:['登录']}});
 const cfg={version:1,environments:{legacy,trusted,production:entry('https://logs.fixture.test/logs',{tier:'prd'}),other:entry('https://logs.fixture.test/logs',{projectId:'other'})}};
 const actor={profile:'owner',senderId:'ou_admin'},oldPlan=planQuery(cfg,{environmentId:'legacy',queryId:'investigate',parameters:['read']},'demo',actor);
 assert.equal(oldPlan.environmentId,'trusted');assert.equal(oldPlan.configHash,(await import('../src/shared/environment-access.js')).fingerprint(trusted));
 assert.deepEqual(catalog(cfg,'demo').map(e=>e.environmentId),['trusted','production']);assert.deepEqual(catalog(cfg,'other').map(e=>e.environmentId),['other']);
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 for(const questionId of ['one','two'])assert.equal((await prepareWebsiteQuery({projects:{projects:{}}},{projectId:'demo',sourceEnvironment:'sit',originProfile:'owner',questionId,context:[]},{url:legacy.baseUrl,tier:'uat',purpose:'read logs'})).environmentId,'trusted');
 const access=await import('../src/shared/environment-access.js');delete trusted.applicationRoot;const historical=planQuery(cfg,{environmentId:'legacy',queryId:'investigate',parameters:['read']},'demo',actor);trusted.applicationRoot=true;
 assert.equal(access.verifyApprovedPlan(cfg,historical).credentialRef,'saved-app');assert.equal(historical.environmentId,'legacy');
 assert.equal(planQuery(cfg,{environmentId:'production',queryId:'investigate',parameters:['read']},'demo',actor).environmentId,'production');
 assert.throws(()=>planQuery(cfg,{environmentId:'trusted',queryId:'absent',parameters:['read']},'demo',actor),/未配置/);
});
