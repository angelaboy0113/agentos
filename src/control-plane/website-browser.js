import {readWebsitePdfPreview} from './website-pdf-preview.js';
import {describePrdCapture} from './prd-capture.js';
import { passivePublicImage, fetchPassivePublicImage } from './public-website-image.js';
import {loginPageAllowed} from '../shared/website-sso.js';
import {websiteFrames,websiteDOM,assertWebsiteFrame} from './website-frames.js';
import {advanceWebsiteDocumentDiagnostics}from'../shared/website-document-diagnostics.js';
import {readWebsiteAsset} from './website-assets.js';
import {inspectWebsiteControl} from '../shared/website-control-inspection.js';
import {loginNavigationPage,loginRenewalPage,validateLoginNavigation} from '../shared/login-navigation.js';
import {websiteControls,controlMetadata,controlMetadataBatch,websiteDialogOpeners,websiteFields} from '../shared/website-controls.js';
import {pageDiagnostic,websiteDiagnostics,pendingWebsiteReads,websiteActionDiagnostics} from '../shared/website-diagnostics.js';
export {controlMetadata} from '../shared/website-controls.js';

function readControlOptions(s){
 const query=s.environment.queries?.[s.job?.environmentAccess?.queryId];
 const url=websiteDOM(s).url();
 return {bindLink:true,hoverTooltip:s.hoverTooltip,readNavigationSelectors:query?.readNavigationSelectors??[],
  dialogOpeners:websiteDialogOpeners(url,query?.readDialogOpeners),
  dialogPreview:s.dialogPreviewUrl===url};
}
import {waitForCaptureReady,screenshotSecretSelector} from '../shared/website-capture.js';
import {browserLoginState,authResponseState} from '../shared/browser-login-state.js';
import { randomUUID,createHash } from 'node:crypto';
import {BrowserInputError,validateBrowserTool,websitePageLocation,websitePageRoute} from '../shared/browser-tool-input.js';
import { chromium } from 'playwright';
import { mkdir, chmod,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { websiteSessionKey, websiteNavigationTarget, websiteReadRecoveryTarget, websiteRequestAllowed, websiteRequestBoundary, websiteStaticResourceAllowed, websiteImageResourceAllowed, websitePdfAttachmentTarget, reviewedPathMatches, cleanWebsiteText,websiteLoginPreferenceAllowed,websiteLoginReadAllowed } from '../shared/website-policy.js';

const transientStaticStatuses = new Set([408, 500, 502, 503, 504]);
const transientStaticErrors = new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EAI_AGAIN',
 'UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const staticFailureCanRetry = error => transientStaticStatuses.has(error.status)
 || transientStaticErrors.has(error.cause?.code ?? error.code) || error.name==='TimeoutError';

async function readPublicResource(fetcher,url,{retry=false,image=false,authorized=async()=>true}={}){
 const options={method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000)};
 const read=async()=>{
  const response=await fetcher(url,options);
  if(response.status!==200){
   await response.body?.cancel().catch(()=>{});
   throw Object.assign(new Error('STATIC_HTTP_STATUS'),{status:response.status});
  }
  const contentType=response.headers.get('content-type')??'application/octet-stream';
  if(image&&!/^image\/(?:jpeg|png|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;|$)/i.test(contentType)){
   await response.body?.cancel().catch(()=>{});
   throw new Error('IMAGE_CONTENT_TYPE');
  }
  return {headers:response.headers,contentType,body:Buffer.from(await response.arrayBuffer())};
 };
 try{return await read();}
 catch(error){
  if(!retry||options.signal.aborted||!staticFailureCanRetry(error)||!await authorized())throw error;
  return read();
 }
}

export function routePrdWebsiteBrowser(shared, isolated) {
 const browser=(job,e)=>job.prd?.auto||e?.loginNavigation?.remoteQr===true?isolated:shared;
 return {
  run:(job,e,...args)=>browser(job,e).run(job,e,...args),
  loginReady:(job,e,...args)=>browser(job,e).loginReady(job,e,...args),
  loginStatusFor:(job,e,...args)=>browser(job,e).loginStatusFor(job,e,...args),
  submitCredentials:(job,e,...args)=>browser(job,e).submitCredentials(job,e,...args),
  beginInteractiveLogin:(job,e)=>browser(job,e).beginInteractiveLogin?.(job,e),
  captureLoginQr:(job,e,...args)=>browser(job,e).captureLoginQr?.(job,e,...args),
  refreshLoginQr:(job,e,...args)=>browser(job,e).refreshLoginQr?.(job,e,...args),
  health:()=>shared.health(),
  release:id=>Promise.allSettled([shared.release(id),isolated.release(id)]),
  close:()=>Promise.allSettled([shared.close(),isolated.close()]),
 };
}
function privateEntryPolicy(environment){
 const navigation=environment.loginNavigation;
 return navigation?.privateEntryMarkers?.length?{baseUrl:environment.baseUrl,markers:navigation.privateEntryMarkers,loginLabel:navigation.steps[0]}:undefined;
}
// One private profile per project/environment/origin. Pages and refs remain per question/job.
export class WebsiteBrowser {
 constructor(dataDir, driver=chromium, authorize=async()=>true,{publicFetch=fetch,passiveImageFetch=fetchPassivePublicImage}={}){this.dataDir=dataDir;this.authorize=authorize;this.publicFetch=publicFetch;this.passiveImageFetch=passiveImageFetch;this.evidenceRoot=path.join(dataDir,'website-evidence');this.root=path.join(dataDir,'website-sessions');this.driver=driver;this.contexts=new Map();this.pages=new Map();this.opening=new Map();}
 async session(e) {
  const key=websiteSessionKey(e.projectId,e.tier,e.baseUrl);
  if(this.contexts.has(key))return this.contexts.get(key);
  if(this.opening.has(key))return this.opening.get(key);
  const p=(async()=>{
   const dir=path.join(this.root,key);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.root,0o700);await chmod(dir,0o700);
   const context=await this.driver.launchPersistentContext(dir,{headless:false,acceptDownloads:false,serviceWorkers:'block',locale:'zh-CN',args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
   const session={context,e,principalFile:path.join(dir,'login-preference-identity.json')};
   try{const p=JSON.parse(await readFile(session.principalFile,'utf8'));if(p.credentialRef===e.credentialRef&&p.accountName===e.loginPreferences?.accountName)session.credentialPrincipal=p;}catch{}
   this.contexts.set(key,session);
   await context.routeWebSocket('**/*',s=>s.close());
   await context.addInitScript(()=>{for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport'])Object.defineProperty(window,key,{value:undefined,configurable:false});});
   await context.route('**/*',async route=>{
    const r=route.request();let page;try{page=r.frame().page();}catch{}
    const state=[...this.pages.values()].find(s=>s.page===page),target=state?.environment??e;
    const request={url:r.url(),method:r.method(),body:r.postData(),resourceType:r.resourceType()};
    const policy=target.queries?.[state?.job?.environmentAccess?.queryId];
    const identityPage=state&&loginPageAllowed(state.page.url(),target.loginNavigation);
    const reviewedImage=state&&websiteImageResourceAllowed(request,policy?.imageResourceRoots);
    const reviewedStatic=state&&websiteStaticResourceAllowed(target.baseUrl,request,policy?.staticResources??[],policy?.staticResourceRoots??[],{identityPage});
    const passiveImage=state&&request.resourceType==='image'&&!reviewedImage&&!reviewedStatic&&!state.waiting&&!identityPage
     &&passivePublicImage(request,r.frame().url(),target.baseUrl)
     &&!websiteLoginReadAllowed(request,true,policy?.loginReads??[],target.baseUrl,target.loginNavigation);
    const image=reviewedImage||passiveImage;
    if(state&&(image||reviewedStatic)){
     // Public GET via an independent client: no browser cookies, tokens, referer,
     // post body, authentication, redirects or response Set-Cookie cross the boundary.
     let permitted=false;try{permitted=await this.authorize(state.job,state.waiting,r);}catch{}
     if(!permitted){await route.abort().catch(()=>{});return;}
     const retry=reviewedStatic&&!image&&['script','stylesheet','font'].includes(request.resourceType);
     const location=websitePageLocation(request.url), document=state.documentEpoch;
     try{
      const resource=await readPublicResource(passiveImage?this.passiveImageFetch:this.publicFetch,request.url,
       {retry,image,authorized:()=>state.documentEpoch===document&&this.authorize(state.job,state.waiting,r)});
      const headers={'content-type':resource.contentType,'cache-control':'no-store'};
      for(const name of ['access-control-allow-origin','cross-origin-resource-policy'])if(resource.headers.has(name))headers[name]=resource.headers.get(name);
      await route.fulfill({status:200,headers,body:resource.body});
     }catch(error){
      if(state.documentEpoch===document){
       state.resourceFailures.add(location);
       if(retry&&staticFailureCanRetry(error))state.recoverableStaticFailures.add(location);
      }
      await route.abort().catch(()=>{});
     }
     return;
    }
    let allow=false,boundary;try{boundary=websiteRequestBoundary(target.baseUrl,request,state?.waiting===true,target.queries?.[state?.job?.environmentAccess?.queryId]?.readEndpoints??[]);allow=boundary.allowed;}catch{}
    const loginReads=target.queries?.[state?.job?.environmentAccess?.queryId]?.loginReads??[];
    if(state&&websiteLoginReadAllowed(request,true,loginReads,target.baseUrl,target.loginNavigation)){
     // The first QR iframe request can precede the next investigator snapshot.
     // Verify an actual visible login/challenge in this same task's parent DOM.
     if(!state.waiting)try{state.waiting=(await state.page.evaluate(browserLoginState,privateEntryPolicy(target))).loginRequired===true;}catch{}
     if(websiteLoginReadAllowed(request,state.waiting,loginReads,target.baseUrl,target.loginNavigation))allow=true;
    }
    if(state&&websiteLoginPreferenceAllowed(target,request,state.session.credentialPrincipal))allow=true;
    else if(state&&request.method==='POST'&&target.loginPreferences?.paths.includes(new URL(request.url).pathname))state.preferenceNeedsIdentity=true;
    if(allow&&!state)allow=false;
    if(allow&&state) {try{allow=await this.authorize(state.job,state.waiting,r);}catch{allow=false;}}
    if(!allow){if(state){if(['script','stylesheet','font','image'].includes(r.resourceType()))state.blockedResources.add(websitePageLocation(r.url()));const location=websitePageLocation(r.url()),pathname=location.slice(new URL(r.url()).origin.length);state.blocked.add(`${r.method()} ${pathname}`);state.blockedRequestDetails??=[];state.blockedRequestDetails.push({at:new Date().toISOString(),method:r.method(),type:r.resourceType(),location,...(boundary?.allowed?{code:'TASK_AUTHORIZATION_REQUIRED',requiresEndpointReview:false}:boundary??{})});if(state.blockedRequestDetails.length>32)state.blockedRequestDetails.shift();if(['xhr','fetch'].includes(r.resourceType())&&!/\.(?:js|css|map|png|jpe?g|svg|ico|woff2?)(?:$)/i.test(new URL(r.url()).pathname)&&new URL(r.url()).origin===new URL(e.baseUrl).origin)state.blockedLoginReads.add(`${r.method()} ${pathname}`);}await route.abort().catch(()=>{});return;}
    if(state?.environment.loginPreferences&&state?.pendingPrincipal&&r.method()==='POST'&&/\/(?:login|signin|sign-in|authenticate|auth|token)(?:\.[a-z]+)?$/i.test(new URL(r.url()).pathname)){
     // Observe this one authentication response before a redirect can discard
     // its body. Forward it unchanged; never retry authentication or fake it.
     try{const response=await route.fetch({maxRedirects:0});await this.acceptAuthentication(state,response);state.authHandled.add(r);await route.fulfill({response});}catch{await route.abort().catch(()=>{});}return;
    }
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   // Chromium creates an unbound startup blank tab. It is not a task or a
   // login window and its requests are intentionally denied by the route gate.
   for(const page of context.pages())if(page.url()==='about:blank')await page.close();
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  const initialTarget=websiteNavigationTarget(job.environmentAccess?.websiteTarget??e.baseUrl,e.baseUrl,e.queries?.[job.environmentAccess?.queryId]?.readEndpoints??[]);
  if(this.pages.has(job.id)){
   const existing=this.pages.get(job.id);
   if(existing.page.isClosed()||existing.crashed||websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(existing.environment.projectId,existing.environment.tier,existing.environment.baseUrl)||e.baseUrl!==existing.environment.baseUrl||initialTarget!==existing.initialTarget)await this.release(job.id);
   else {existing.job=job;existing.environment=e;return existing;}
  }
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,environment:e,initialTarget,restoreTarget:Boolean(job.environmentAccess?.websiteTarget),refPrefix:randomUUID(),observedScripts:new Set(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set(),blockedResources:new Set(),resourceFailures:new Set(),recoverableStaticFailures:new Set(),staticRecoveryTargets:new Set(),pageErrors:new Set(),blockedLoginReads:new Set(),pendingReads:new Set(),pendingReadMetadata:new WeakMap(),detachedReads:new WeakSet(),authHandled:new WeakSet(),lastReadActivity:Date.now()};this.pages.set(job.id,s);
  page.on('crash',()=>{s.crashed=true;});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())advanceWebsiteDocumentDiagnostics(s,frame.url());});
  page.on('pageerror',error=>{s.pageErrors.add(/^[A-Za-z]+Error$/.test(error.name)?error.name:'RuntimeError');pageDiagnostic(s,{name:error.name,message:error.message});});
  page.on('console',message=>{if(['error','warning'].includes(message.type())){const loc=message.location();pageDiagnostic(s,{kind:'console-'+message.type(),source:loc.url,line:loc.lineNumber,column:loc.columnNumber,message:message.text()});}});
  page.on('request',request=>{
   if(request.resourceType()==='script')s.observedScripts.add(request.url());
   if(['xhr','fetch','document'].includes(request.resourceType())&&new URL(request.url()).origin===new URL(s.environment.baseUrl).origin){pageDiagnostic(s,{kind:'request',source:request.url(),method:request.method()});s.pendingReads.add(request);s.lastReadActivity=Date.now();s.pendingReadMetadata.set(request,{startedAt:s.lastReadActivity,queryInitiated:['xhr','fetch'].includes(request.resourceType())&&(s.queryAction===true||request.timing().startTime>=s.lastQueryAction?.startedAt&&request.timing().startTime<=s.lastQueryAction?.endedAt)});}
  });
  const settled=request=>{if(s.pendingReads.delete(request))s.lastReadActivity=Date.now();};
  page.on('requestfinished',settled);page.on('requestfailed',settled);
  page.on('response',async response=>{
   const req=response.request(),url=new URL(response.url());if(s.detachedReads.has(req)||url.origin!==new URL(e.baseUrl).origin)return;
   const tail=url.pathname.split('/').filter(Boolean).at(-1)??'';
   if(req.method()==='POST'&&/^(?:login|signin|sign-in|authenticate|auth|token)(?:\.[a-z]+)?$/i.test(tail)){
    if(!s.authHandled.has(req))await this.acceptAuthentication(s,response);return;
   }
   const reviewed=s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readEndpoints??[];
   if(['xhr','fetch','document','script','stylesheet'].includes(req.resourceType()))pageDiagnostic(s,{kind:'response',source:response.url(),method:req.method(),status:response.status()});
   if(s.waiting&&response.status()>=400&&['xhr','fetch'].includes(req.resourceType())&&reviewed.some(x=>x.method===req.method()&&reviewedPathMatches(x.path,url.pathname)))s.bootstrapFailure={method:req.method(),path:url.pathname,status:response.status()};
  });
  page.setDefaultTimeout(10000);page.on('download',d=>d.cancel().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));page.on('dialog',d=>d.dismiss().catch(()=>{}));
  try{await page.goto(initialTarget,{waitUntil:'domcontentloaded',timeout:30000});}catch(error){
   // A committed application can still be waiting on a slow script or auth
   // resource. Keep this exact tab and its diagnostics instead of discarding a
   // usable login page and creating another blank window on the next tool.
   let committed=false;try{committed=error.name==='TimeoutError'&&new URL(page.url()).origin===new URL(initialTarget).origin;}catch{}
   if(!committed){await this.release(job.id);throw error;}
   pageDiagnostic(s,{kind:'navigation-timeout',source:page.url(),name:error.name});
  }
  return s;
 }
 async acceptAuthentication(s,response){
  s.authPostSeen=true;let payload;try{payload=await response.json();}catch{}
  s.authResult=authResponseState(response.status(),payload);
  const accepted=payload?.success===true||payload?.ok===true||[0,200,'0','200','00000','000000'].includes(payload?.code)||[payload?.token,payload?.access_token,payload?.data?.token,payload?.data?.access_token].some(x=>typeof x==='string'&&x.length>0);
  if(s.pendingPrincipal&&response.status()>=200&&response.status()<300&&!s.authResult&&accepted){s.session.credentialPrincipal=s.pendingPrincipal;try{await writeFile(s.session.principalFile,JSON.stringify(s.pendingPrincipal),{mode:0o600});}catch{}}
  else {delete s.session.credentialPrincipal;await rm(s.session.principalFile,{force:true}).catch(()=>{});}
  delete s.pendingPrincipal;
 }
 async readAcrossNavigation(s,read){
  const deadline=Date.now()+30000;
  for(;;)try{return await read();}catch(error){
   if(!/Execution context was destroyed|Cannot find context with specified id|Frame was detached/i.test(error.message??'')||Date.now()>=deadline)throw error;
   await s.page.waitForLoadState('domcontentloaded',{timeout:Math.max(1,deadline-Date.now())});
   if(!await this.authorize(s.job,s.waiting,{url:()=>s.initialTarget,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('页面跳转后原读取范围已失效');
   // Retry only this idempotent DOM read across a redirect chain, never an action.
  }
 }
 async loginStatus(s){
  if(s.preferenceNeedsIdentity&&!s.reloginAttempted&&s.environment.loginPreferences){
   if(!await this.authorize(s.job,true,{url:()=>s.environment.loginPreferences.loginUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('当前任务没有有效登录恢复范围');
   s.reloginAttempted=true;s.preferenceNeedsIdentity=false;
   await s.page.goto(s.environment.loginPreferences.loginUrl,{waitUntil:'domcontentloaded',timeout:30000});
  }
  await assertWebsiteFrame(s);
  const state=await this.readAcrossNavigation(s,()=>websiteDOM(s).evaluate(browserLoginState,privateEntryPolicy(s.environment)));
  // An identity-provider success page is not a successful application login.
  if(new URL(s.page.url()).origin!==new URL(s.environment.baseUrl).origin){state.pageReady=false;state.loginRequired=true;if(!state.verificationRequired&&!state.passwordChangeRequired&&!state.credentialRejected){state.loginState=loginPageAllowed(s.page.url(),s.environment.loginNavigation)?'login_required':'request_error';if(state.loginState==='request_error')state.requestFailed=true;}}
  if(state.verificationRequired&&state.verificationFramePresent){
   for(const frame of s.page.frames())if(frame!==s.page.mainFrame()){
    const expired=await frame.evaluate(()=>/二维码.{0,8}(?:失效|过期)|QR code.{0,15}expired/i.test(document.body?.innerText??'')).catch(()=>false);
    if(expired)state.verificationExpired=true;
   }
  }
  if(state.loginRequired&&s.authResult&&!state.verificationRequired&&!state.passwordChangeRequired)Object.assign(state,s.authResult);
  if(state.loginRequired){s.waiting=true;s.sawLogin=true;if(s.bootstrapFailure&&!state.credentialRejected&&!state.verificationRequired&&!state.passwordChangeRequired){const code=s.bootstrapFailure.status;Object.assign(state,code===429?{loginState:'rate_limited',rateLimited:true}:code>=500?{loginState:'service_error',serviceUnavailable:true}:{loginState:'request_error',requestFailed:true});}}
  else if(state.pageReady){if(s.waiting&&s.sawLogin)s.reloadAfterLogin=s.restoreTarget===true&&s.page.url()!==s.initialTarget;s.waiting=false;s.credentialAttempted=false;s.authResult=null;s.bootstrapFailure=null;s.renewalAttempted=false;}
  if(s.blockedLoginReads.size&&state.loginRequired&&!state.credentialRejected)state.blockedRequests=[...s.blockedLoginReads].slice(-8);
  return {...state,diagnostic:{credentialAttempted:s.credentialAttempted===true,authRequestObserved:s.authPostSeen===true,authResult:s.authResult?.loginState??null,blockedRequests:[...s.blockedLoginReads].slice(-8),bootstrapFailure:s.bootstrapFailure??null}};
 }
 async needsLogin(s){const state=await this.loginStatus(s);return state.loginRequired;}
 async beginInteractiveLogin(job,e){
  const navigation=validateLoginNavigation(e.loginNavigation);if(navigation.interactive!==true)throw Error('没有审核的交互登录入口');
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('原任务登录范围已失效');
  const s=await this.state(job,e);s.waiting=true;
  const before=await this.loginStatus(s);if(before.verificationRequired||navigation.privateEntryMarkers&&before.pageReady)return before;
  s.waiting=true;
  await this.readAcrossNavigation(s,()=>waitForCaptureReady(s));
  if(loginPageAllowed(s.page.url(),navigation)){
   if(navigation.renewal&&!s.renewalAttempted){
    const rules=e.queries?.[job.environmentAccess?.queryId]?.loginReads??[];
    if(!rules.some(r=>r.method==='POST'&&r.reviewed===true&&r.bodyParameters&&Object.keys(r.bodyParameters).length>=3))throw Error('已有授权恢复缺少原应用、账号和权限的固定认证请求绑定');
    const result=await s.page.evaluate(loginRenewalPage,navigation.renewal);if(result.attempted)s.renewalAttempted=true;
   }
   // Open the provider's alternate sign-in screen instead of choosing a saved
   // identity on behalf of the operator.
   const switchAccount=s.page.getByRole('button',{name:/^(?:使用其他账号登录|Use another account)$/i});
   if(await switchAccount.count()===1&&await switchAccount.isVisible())await switchAccount.click();
   return this.loginStatus(s);
  }
  for(const step of navigation.steps){const r=await s.page.evaluate(loginNavigationPage,{...navigation,baseUrl:e.baseUrl,step});if(r.error)throw Error(r.error);if(r.ready)break;}
  return this.loginStatus(s);
 }
 async loginStatusFor(job,e){
  const s=await this.state(job,e);
  if(s.page.url()==='about:blank'&&!s.blankRecovery){
   if(!await this.authorize(job,true,{url:()=>s.initialTarget,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('当前任务没有有效恢复范围');
   s.blankRecovery=s.page.goto(s.currentReadTarget??s.initialTarget,{waitUntil:'domcontentloaded',timeout:30000});
   try{await s.blankRecovery;}finally{s.blankRecovery=null;}
  }
  let status=await this.loginStatus(s);
  if(status.loginState==='loading'&&!s.operation&&!s.loginRecovery&&s.pendingReads?.size===0&&s.blockedResources?.size===0&&s.resourceFailures?.size===0&&Date.now()-s.lastReadActivity>1500&&Date.now()-(s.quietLoginRecoveryAt??0)>30000){
   s.quietLoginRecoveryAt=Date.now();s.loginRecovery=this.perform(s,'browser_recover',{});
   try{await s.loginRecovery;}finally{s.loginRecovery=null;}
   status=await this.loginStatus(s);
  }
  return status;
 }
 // Authentication challenge only: never use the business screenshot delivery path.
 async captureLoginQr(job,e){
  if(e.loginNavigation?.remoteQr!==true||e.loginNavigation.interactive!==true)throw Error('Remote QR not configured');
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('Login scope expired');
  const s=await this.state(job,e),status=await this.loginStatus(s);
  if(!status.loginRequired||!status.verificationRequired||status.verificationExpired)return null;
  const candidates=[];
  for(const frame of s.page.frames())for(const img of await frame.locator('img').all()){
   const src=await img.getAttribute('src');if(!/(?:qrcode|\/qr\/|data:image)/i.test(src??''))continue;
   const box=await img.boundingBox();if(box&&box.width>=100&&box.height>=100&&await img.isVisible())candidates.push(img);
  }
  // Some identity providers draw the challenge on a canvas instead of an img.
  // Only an explicitly reviewed identity page can contribute a canvas candidate.
  if(loginPageAllowed(s.page.url(),e.loginNavigation))for(const frame of s.page.frames())for(const canvas of await frame.locator('canvas').all()){
   const box=await canvas.boundingBox();if(!box||box.width<100||box.height<100||Math.abs(box.width-box.height)>2||!await canvas.isVisible())continue;
   const drawn=await canvas.evaluate(c=>{try{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0,light=0;for(let i=0;i<d.length;i+=4){if(d[i+3]<200)continue;if(d[i]<60&&d[i+1]<60&&d[i+2]<60)dark++;if(d[i]>195&&d[i+1]>195&&d[i+2]>195)light++;}return dark>c.width*c.height*.1&&light>c.width*c.height*.1;}catch{return false;}});
   if(drawn)candidates.push(canvas);
  }
  if(candidates.length!==1)return null; // An ambiguous page must never expose an arbitrary image.
  const buffer=await candidates[0].screenshot({type:'png',timeout:10000});
  if(buffer.length>2*1024*1024||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid QR image');
  const after=await this.loginStatus(s);if(!after.loginRequired||after.verificationExpired)return null;
  return {buffer,sha256:createHash('sha256').update(buffer).digest('hex')};
 }
 async refreshLoginQr(job,e){
  if(e.loginNavigation?.remoteQr!==true)throw Error('Remote QR not configured');
  const s=await this.state(job,e),status=await this.loginStatus(s);if(!status.loginRequired)return;
  if(!await this.authorize(job,true,{url:()=>s.initialTarget,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('Login scope expired');
  if(status.verificationExpired&&loginPageAllowed(s.page.url(),e.loginNavigation)){
   const refresh=s.page.getByText(/^(?:刷新二维码|Refresh QR code)$/i);
   if(await refresh.count()===1&&await refresh.isVisible()){
    await refresh.click();
    return this.loginStatus(s);
   }
  }
  await s.page.goto(s.initialTarget,{waitUntil:'domcontentloaded',timeout:30000});
  return this.beginInteractiveLogin(job,e); // Explicit administrator request, no business operation replay.
 }
 async loginReady(job,e){const s=await this.state(job,e);return (await this.loginStatus(s)).pageReady===true;}
 async submitCredentials(job,e,cred,{force=false}={}){
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw new Error('当前任务没有有效网站登录范围');
  const opened=this.pages.get(job.id);
  if(opened&&(websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(opened.environment.projectId,opened.environment.tier,opened.environment.baseUrl)||opened.environment.baseUrl!==e.baseUrl))throw new Error('凭据目标与已打开的任务登录范围不一致；本次未导航或填写');
  const s=await this.state(job,e);
  const current=new URL(s.page.url()),base=new URL(e.baseUrl),prefix=base.pathname.replace(/\/$/,'');
  const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash);
  if(current.origin!==base.origin||(!authPath&&!(current.pathname===prefix||current.pathname.startsWith(prefix+'/'))))throw new Error('浏览器已离开本次批准的登录范围');
  let before=await this.loginStatus(s);
  if(!before.pageReady&&e.loginNavigation){const navigation=validateLoginNavigation(e.loginNavigation);for(const step of navigation.steps){const result=await s.page.evaluate(loginNavigationPage,{baseUrl:e.baseUrl,usernameLabel:navigation.usernameLabel,entryUrl:navigation.entryUrl,step});if(result.error)throw Error(result.error);if(result.ready)break;await s.page.waitForTimeout(150);}const result=await s.page.evaluate(loginNavigationPage,{baseUrl:e.baseUrl,usernameLabel:navigation.usernameLabel});if(!result.ready)throw Error(result.error??'登录账号身份入口尚未就绪，未填写凭据');before=await this.loginStatus(s);}
  if(before.pageReady)return {...before,authenticated:true,attempted:false};
  const policy=createHash('sha256').update(JSON.stringify([e.projectId,e.tier,e.baseUrl,e.credentialRef,job.environmentAccess?.queryId,e.queries?.[job.environmentAccess?.queryId]?.readEndpoints??[],e.queries?.[job.environmentAccess?.queryId]?.imageResourceRoots??[]])).digest('hex');
  const correctedPolicy=s.authAttemptPolicy!==undefined&&s.authAttemptPolicy!==policy;
  if(!force&&(before.rateLimited||s.credentialAttempted&&(before.credentialRejected||!correctedPolicy)))return {...before,authenticated:false,attempted:false};
  if(before.passwordChangeRequired)return {...before,authenticated:false,attempted:false};
  const password=websiteDOM(s).locator('input[type="password"]:visible').first();
  if(!await password.count())return {...before,authenticated:before.pageReady===true,attempted:false};
  s.authResult=null;s.authPostSeen=false;s.bootstrapFailure=null;s.blockedLoginReads.clear();
  const form=password.locator('xpath=ancestor::form[1]');const scope=await form.count()?form:websiteDOM(s).locator('body');
  const inputs=scope.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):visible');
  let username=inputs.first();for(let i=0;i<await inputs.count();i++){const el=inputs.nth(i);const label=await el.evaluate(x=>[x.name,x.id,x.autocomplete,x.placeholder,x.getAttribute('aria-label')].join(' '));if(/user|account|login|email|phone|mobile|账号|用户|邮箱|手机/i.test(label)){username=el;break;}}
  if(await username.count())await username.fill(cred.username);
  await password.fill(cred.password);
  if(before.verificationRequired)return {...before,authenticated:false,attempted:false};
  const named=scope.getByRole('button',{name:/^(?:登\s*录|登\s*入|sign\s*in|log\s*in|submit|确定|继续)$/i}).first();
  const submit=await named.count()?named:scope.locator('button[type="submit"]:visible,input[type="submit"]:visible').first();
  if(await submit.count()){s.credentialAttempted=true;s.authAttemptPolicy=policy;if(e.loginPreferences)s.pendingPrincipal={credentialRef:e.credentialRef,accountName:cred.username};await submit.click();}else return {...before,authenticated:false,attempted:false,credentialRejected:false,submissionUnconfirmed:true,loginState:'submission_control_missing'};
  await s.page.waitForTimeout(1200);const status=await this.loginStatus(s);
  if(status.pageReady)s.credentialAttempted=false;
  return {...status,authenticated:status.pageReady===true,attempted:true,submissionUnconfirmed:!s.authPostSeen&&status.loginRequired};
 }
 async run(job,e,tool,args={}) {
  validateBrowserTool(tool,args);
  const s=await this.state(job,e);
  // A ref belongs to one immutable element handle in one page generation, never nth(i).
  const previous=s.operation??Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{if(tool!=='browser_frames'&&tool!=='browser_frame'&&tool!=='browser_recover'&&tool!=='browser_diagnostics'&&tool!=='browser_navigate')await assertWebsiteFrame(s);const result=await (['connection','browser_open','browser_snapshot','browser_read','browser_assets','browser_inspect','browser_frames'].includes(tool)?this.readAcrossNavigation(s,()=>this.perform(s,tool,args)):this.perform(s,tool,args));if(tool!=='browser_frames'&&tool!=='browser_recover'&&tool!=='browser_diagnostics'&&tool!=='browser_navigate')await assertWebsiteFrame(s);return result;});s.operation=operation;
  try{return await operation;}finally{if(s.operation===operation)s.operation=null;}
 }
 async recoverStaticDocument(s,status){
  if(!status||status.loginRequired||status.loginState==='access_denied'||s.dom||s.pendingReads.size
    ||s.blockedResources.size||!s.recoverableStaticFailures.size)return null;
  const target=s.page.url();
  if(s.staticRecoveryTargets.has(target))return null;
  try{websiteNavigationTarget(target,s.environment.baseUrl,s.environment.queries?.[s.job.environmentAccess?.queryId]?.readEndpoints??[]);}
  catch{return null;}
  if(!await this.authorize(s.job,false,{url:()=>target,method:()=> 'GET',resourceType:()=> 'document'}))return null;
  s.staticRecoveryTargets.add(target);
  s.frameRefs?.clear();s.assets?.clear();s.observedScripts.clear();
  s.lastRecovery={at:new Date().toISOString(),kind:'reviewed-static-reloaded',target:websitePageLocation(target)};
  await s.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
  return this.loginStatus(s);
 }
 async recoverReadLanding(s, login) {
  const query = s.environment.queries?.[s.job.environmentAccess?.queryId];
  if (!query?.readRecoveryTarget || login.loginState !== 'loading' || s.readLandingAttempt || s.lastReadAction
    || s.currentReadTarget || s.blockedResources.size || s.resourceFailures.size) return login;
  const target = websiteReadRecoveryTarget(query.readRecoveryTarget,s.environment.baseUrl,query.readEndpoints);
  if (target === s.page.url() || target === s.initialTarget) return login;
  const ready = await waitForCaptureReady(s,{timeoutMs:5000});
  login = await this.loginStatus(s);
  if (ready.status!=='blank_timeout' || login.loginState!=='loading' || s.pendingReads.size
    || s.blockedResources.size || s.resourceFailures.size
    || !await this.authorize(s.job,false,{url:()=>target,method:()=> 'GET',resourceType:()=> 'document'})) return login;

  s.readLandingAttempt=target;
  s.currentReadTarget=target;s.restoreTarget=true;
  const documentStart=await s.page.evaluate(()=>performance.timeOrigin);
  s.dom=null;s.frameRefs?.clear();
  await s.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
  login=await this.loginStatus(s);
  // A hash-only change can leave the same stalled application shell in place.
  // Reload the approved read view only when it has not started new reads.
  if(login.loginState==='loading' && s.page.url()===target && !s.pendingReads.size
    && await s.page.evaluate(()=>performance.timeOrigin)===documentStart){
   await s.page.reload({waitUntil:'domcontentloaded',timeout:30000});
  }
  s.lastRecovery={at:new Date().toISOString(),kind:'verified-read-landing',target:websitePageLocation(target)};
  return this.loginStatus(s);
 }
 async perform(s,tool,args){
  if(tool==='browser_diagnostics')return websiteDiagnostics(s);
  if(tool==='browser_frames')return websiteFrames(s);
  if(tool==='browser_frame'){await websiteFrames(s,args.ref);return this.snapshot(s);}
  if(tool==='browser_navigate'){
   let target;try{target=websiteNavigationTarget(args.url,s.environment.baseUrl,s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readEndpoints??[]);}catch{throw new BrowserInputError('BROWSER_ARGUMENTS','目标地址未通过同应用只读校验；使用已观察到的菜单或源码地址，不能传凭据、修改动作或其它应用地址。');}
   if(!await this.authorize(s.job,s.waiting,{url:()=>target,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('原任务页面导航范围已失效');
   const priorReads=new Set(s.pendingReads),priorDocument=await s.page.evaluate(()=>performance.timeOrigin);
   s.currentReadTarget=target;s.restoreTarget=true;s.dom=null;s.frameRefs=new Map();
   // Navigation only: never replay the query, login submission or business action.
   await s.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
   const documentChanged=await s.page.evaluate(()=>performance.timeOrigin)!==priorDocument;
   if(documentChanged){
    // Old document reads cannot supply this document's answer or keep its guard
    // pending. Detach local observations; do not claim the backend query stopped.
    for(const request of priorReads){s.detachedReads.add(request);s.pendingReads.delete(request);}
    s.lastReadDetach={at:new Date().toISOString(),supersededPendingReads:priorReads.size,serverCancellationConfirmed:false};
    s.lastReadAction=null;s.lastQueryAction=null;
   }
   return {...await this.snapshot(s),...await this.loginStatus(s),navigation:{requested:websitePageLocation(target),requestedRoute:websitePageRoute(target),actual:websitePageLocation(s.page.url()),actualRoute:websitePageRoute(s.page.url()),targetMatched:s.page.url()===target,readOnly:true,documentChanged,...(documentChanged?s.lastReadDetach:{})}};
  }
  const blank=s.page.url()==='about:blank';
  let login;
  if(blank||tool==='browser_recover'){
   if(!await this.authorize(s.job,s.waiting,{url:()=>s.initialTarget,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('当前任务没有有效恢复范围');
   const status=blank?null:await this.recoverReadLanding(s,await this.loginStatus(s));
   if(s.lastRecovery?.kind==='verified-read-landing')login=status;
   if(!blank&&status?.loginRequired)return {...status,stage:'页面在等待认证，沿用已有登录恢复；本次不重新提交凭据'};
   if(!login&&!blank)login=await this.recoverStaticDocument(s,status);
   if(!login&&(blank||status.loginState==='loading'&&!s.pendingReads.size&&!s.blockedResources.size&&!s.resourceFailures.size)){s.dom=null;s.frameRefs?.clear();s.assets?.clear();s.observedScripts.clear();await s.page.goto(s.currentReadTarget??s.initialTarget,{waitUntil:'domcontentloaded',timeout:30000});s.lastRecovery={at:new Date().toISOString(),kind:blank?'blank-reopened':'quiet-empty-reloaded',target:websitePageLocation(s.currentReadTarget??s.initialTarget)};}
   else if(!login&&status.loginState==='loading')return {stage:'保留当前加载与故障证据，尚未重复导航',pageStatus:'loading',partial:true,url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),diagnostic:{blockedResources:[...s.blockedResources],resourceFailures:[...s.resourceFailures],pageErrorCategories:[...s.pageErrors],pendingReads:s.pendingReads.size},next:s.pendingReads.size?'当前有读取进行中，检查后续快照，不重复点击或打开':'核对实际静态依赖或使用browser_assets继续部署源码取证；不把资源失败当作密码错误'};
  }
  if(tool==='browser_assets')return readWebsiteAsset(s,args,this.authorize,this.publicFetch);
  login??=await this.loginStatus(s);
  if(['connection','browser_open','browser_snapshot'].includes(tool))login=await this.recoverReadLanding(s,login);
  if(login.loginRequired){await s.page.bringToFront();return {loginRequired:true,...(login.privateLoginRequired?{privateLoginRequired:true}:{}),stage:'等待网站登录',message:'登录后自动继续原问题，无需回复继续。'};}
  if(login.loginState==='access_denied')return {stage:'站点拒绝访问，业务页面未就绪',loginState:login.loginState,
   pageStatus:'access_denied',url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),
   partial:true,pageText:'',controls:[],diagnostic:websiteDiagnostics(s),message:'查看同任务页面诊断中的实际受阻初始化请求或应用授权；拒绝页不能作为真实业务页面截图。'};
  if(tool==='browser_screenshot')return this.screenshot(s,args);
  if(!login.pageReady)return {diagnostic:{blockedResources:[...s.blockedResources],resourceFailures:[...s.resourceFailures],pageErrorCategories:[...s.pageErrors],pendingReads:s.pendingReads.size,readOnly:true},loginState:login.loginState,stage:'页面尚未就绪',pageStatus:'loading',url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),partial:true,pageText:'',controls:[],...(s.lastRecovery?{recovery:s.lastRecovery}:{}),message:'尚未取得可见业务内容，不能认定登录成功或页面正常。'};
  if(s.reloadAfterLogin){s.reloadAfterLogin=false;await s.page.goto(s.currentReadTarget??s.initialTarget,{waitUntil:'domcontentloaded'});}
  if(tool==='browser_read')return this.readVisible(s,args);
  if(tool==='connection'||tool==='browser_open'||tool==='browser_snapshot'||tool==='browser_recover')return {...await this.snapshot(s),...(s.lastRecovery?{recovery:s.lastRecovery}:{})};
  if(tool==='browser_key'&&args.ref==='page'){await s.page.keyboard.press('Escape');return this.snapshot(s);}
  if(tool==='browser_scroll'&&args.ref==='page'){await s.page.evaluate(direction=>window.scrollBy(direction==='left'?-600:direction==='right'?600:0,direction==='up'?-600:direction==='down'?600:0),args.direction);return this.snapshot(s);}
  const ref=s.refs.get(args.ref);if(!ref)throw new BrowserInputError('BROWSER_REF_STALE','页面引用已过期；先browser_snapshot，再使用新引用。');
  const current=await ref.el.evaluate(controlMetadata,readControlOptions(s)).catch(()=>null);
  if(!current||!current.visible)throw new BrowserInputError('BROWSER_REF_STALE','原控件已移除或隐藏；先browser_snapshot，不重复旧操作。');
  if(current.label!==ref.rawLabel||current.type!==ref.type||current.kind!==ref.kind||current.linkHref!==ref.linkHref)throw new BrowserInputError('BROWSER_CONTROL_CHANGED','控件内容或用途已改变；重新读取snapshot后选择，不执行原操作。');
  if(current.blocked)throw new Error('该操作可能改变业务状态，本次未执行');
  if(tool==='browser_inspect')return {url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),label:cleanWebsiteText(current.label),...await ref.el.evaluate(inspectWebsiteControl)};
  if(tool==='browser_context_menu'){
   if(current.kind!=='row')throw new BrowserInputError('BROWSER_CONTROL_TYPE','仅可打开当前快照数据行的上下文菜单，不执行任何菜单项。');
   await ref.el.click({button:'right',timeout:8000});return this.snapshot(s);
  }
  if(tool==='browser_hover'){
   if(ref.type!=='inspect'||!['menu-trigger','label-trigger'].includes(current.kind))throw new BrowserInputError('BROWSER_CONTROL_TYPE','只能悬停当前快照登记的菜单或图标提示触发器；不点击未知操作。');
   const prior=await websiteDOM(s).locator('[role="tooltip"]:visible').elementHandles(),owned=!!s.hoverTooltip;
   for(const handle of [s.hoverTooltip?.element,s.hoverTooltip?.tooltip])await handle?.dispose().catch(()=>{});s.hoverTooltip=null;
   let tips=[];
   try {
    const texts=await Promise.all(prior.map(h=>h.innerText()));
    await ref.el.hover({timeout:8000});
    // Wait only for the local hover animation, never replay a business request.
    await s.page.waitForTimeout(400);
    tips=await websiteDOM(s).locator('[role="tooltip"]:visible').elementHandles();
    if(tips.length===1){const label=(await tips[0].innerText()).trim();let existing=false;for(let i=0;i<prior.length;i++)if(await tips[0].evaluate((el,old)=>el===old,prior[i])&&texts[i].trim()===label)existing=true;
     if(label&&label.length<=100&&(!existing||owned))s.hoverTooltip={element:await ref.el.evaluateHandle(el=>el),tooltip:tips[0],label};
    }
   }catch(error){
    if(error.name==='TimeoutError')throw new BrowserInputError('BROWSER_OPERATION_TIMEOUT','悬停未确认完成。请刷新页面快照，从当前可见菜单或其他已审核的只读入口继续。');
    if(/Element is not attached|Execution context was destroyed/i.test(error.message))throw new BrowserInputError('BROWSER_REF_STALE','悬停期间页面或控件已变化；请刷新快照，使用新引用继续。');
    throw error;
   }finally{
    for(const handle of [...prior,...tips.filter(h=>h!==s.hoverTooltip?.tooltip)])await handle.dispose().catch(()=>{});
   }
   return this.snapshot(s);
  }
  if(ref.type==='inspect')throw new BrowserInputError('BROWSER_CONTROL_TYPE','该引用只允许检查或悬停，不能点击、输入或按键执行。');
  const expected={browser_search:'search',browser_select:'select',browser_click:'read-action'}[tool];
  if(!['browser_key','browser_scroll'].includes(tool)&&ref.type!==expected&&!(tool==='browser_click'&&ref.type==='search'))throw new BrowserInputError('BROWSER_CONTROL_TYPE','当前引用不是该工具对应的控件；菜单和详情用browser_click，输入框用browser_search，原生下拉框用browser_select。');
  s.lastReadAction={tool,controlLabel:cleanWebsiteText(current.label).slice(0,100),controlKind:current.kind,startedAt:new Date().toISOString()};
  if(current.kind==='dialog-opener')s.dialogPreviewUrl=websiteDOM(s).url();
  s.queryAction=(tool==='browser_click'&&current.kind==='query')||(tool==='browser_key'&&args.key==='Enter'&&ref.type==='search');
  if(s.queryAction)s.lastQueryAction={startedAt:Date.now(),endedAt:Infinity};
  try{
   if(tool==='browser_key')await ref.el.press(args.key,{timeout:8000});
   else if(tool==='browser_scroll')await ref.el.evaluate((el,direction)=>{let p=el;const horizontal=['left','right'].includes(direction);while(p&&!(horizontal?p.scrollWidth>p.clientWidth:p.scrollHeight>p.clientHeight))p=p.parentElement;(p??document.scrollingElement).scrollBy(horizontal?(direction==='left'?-600:600):0,horizontal?0:(direction==='up'?-600:600));},args.direction);
   else if(tool==='browser_search'){
    const textControl=await ref.el.evaluate(el=>el.tagName==='TEXTAREA'||el.tagName==='INPUT'&&['text','search','tel','url','email'].includes(el.type));
    await ref.el.fill(args.text,{timeout:8000});
    if(textControl&&await ref.el.inputValue({timeout:8000})!==args.text){
     // Controlled inputs may ignore insertText and only reconcile after native
     // delete/typing events. Stay on this exact approved field, never submit.
     if(!/[\x00-\x1f\x7f]/.test(args.text)){
      await ref.el.selectText({timeout:8000});
      await ref.el.press('Backspace',{timeout:8000});
      if(args.text)await ref.el.type(args.text,{timeout:8000});
     }
     if(await ref.el.inputValue({timeout:8000})!==args.text)throw new BrowserInputError('BROWSER_CONTENT_CHANGED','页面没有保留本次输入，查询尚未提交。请先查看最新页面快照，避免按旧条件查询。');
    }
   }
   else if(tool==='browser_select')await ref.el.selectOption(args.value,{timeout:8000});
   else {
    const link=await ref.el.evaluate(el=>{
     const anchor=el.closest('a[href]');
     if(!anchor)return null;
     // A literal placeholder has no destination. Let the application's
     // existing click handler open its inline details, under the request gate.
     if(!anchor.target&&/^javascript:(?:;|void\(0\);?)$/i.test(anchor.getAttribute('href').trim()))return null;
     return anchor.target==='_blank'||anchor.origin!==el.ownerDocument.location.origin?anchor.href:null;
    });
    if(link&&link!==ref.linkHref)throw new BrowserInputError('BROWSER_REF_STALE','附件链接已变化，请刷新快照后再查看。');
    const policy=s.environment.queries?.[s.job?.environmentAccess?.queryId];
    if(link){
     const attachment=websitePdfAttachmentTarget(link,policy?.pdfAttachmentRoots);
     if(attachment){
      const evidence=await readWebsitePdfPreview({dataDir:this.dataDir,jobId:s.job.id,target:attachment,fetchPdf:this.publicFetch,
       authorize:()=>this.authorize(s.job,s.waiting,{url:()=>attachment,method:()=> 'GET',resourceType:()=> 'document'})});
      return {...await this.snapshot(s),attachmentPreview:evidence};
     }
     const target=websiteNavigationTarget(link,s.environment.baseUrl,policy?.readEndpoints??[]);
     if(!await this.authorize(s.job,s.waiting,{url:()=>target,method:()=> 'GET',resourceType:()=> 'document'}))throw Error('原任务页面导航范围已失效');
     s.currentReadTarget=target;
     await s.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
    }else {
     // A reviewed read action may synchronously use window.open instead of an
     // anchor. Capture its destination without opening an unbound page; then
     // apply the same application and request authorization as normal links.
     const popupKey='__agentos_read_popup_'+randomUUID();
     await ref.el.evaluate((el,key)=>{const w=el.ownerDocument.defaultView,original=w.open;const capture={urls:[],original};capture.hook=function(url){capture.urls.push(String(url??''));return null;};w[key]=capture;w.open=capture.hook;},popupKey);
     let popupTargets=[];
     try{await ref.el.click({timeout:8000});}
     finally{try{popupTargets=await ref.el.evaluate((el,key)=>{const w=el.ownerDocument.defaultView,c=w[key];if(!c)return [];if(w.open===c.hook)w.open=c.original;delete w[key];return c.urls;},popupKey);}catch{/* Navigation destroyed the old document and its local capture. */}}
     if(popupTargets.length){
      if(popupTargets.length!==1)throw new BrowserInputError('BROWSER_POPUP_AMBIGUOUS','本次只读操作出现多个新窗口目标；保留当前页面，不猜测选择或重复点击。');
      if(!popupTargets[0]||popupTargets[0]==='about:blank')throw new BrowserInputError('BROWSER_POPUP_TARGET_PENDING','详情新窗口尚无实际地址；没有把空白页当证据或重复打开。');
      const target=websiteNavigationTarget(new URL(popupTargets[0],websiteDOM(s).url()).href,s.environment.baseUrl,s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readEndpoints??[]);
      if(!await this.authorize(s.job,s.waiting,{url:()=>target,method:()=> 'GET',resourceType:()=> 'document'}))throw new BrowserInputError('BROWSER_NAVIGATION_SCOPE','新窗口详情不在本任务批准的读取范围，保留当前页。');
      s.currentReadTarget=target;s.dom=null;s.frameRefs=new Map();
      await s.page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
     }
    }
   }
  }catch(error){if(error.code==='BROWSER_NAVIGATION_SCOPE'&&!(error instanceof BrowserInputError))throw new BrowserInputError(error.code,'链接不在本任务批准的页面或附件目录内。可用 browser_inspect 确认目标，原页面仍可调查。');if(error.name==='TimeoutError')throw new BrowserInputError('BROWSER_OPERATION_TIMEOUT','本次控件操作未确认完成；不要重复点击，先browser_snapshot核对页面是否变化，再决定下一步。不能将工具超时认定为网站故障。');throw error;}finally{if(s.queryAction){await ref.el.evaluate(()=>undefined).catch(()=>{});s.lastQueryAction.endedAt=Date.now();}s.queryAction=false;s.lastReadAction.endedAt=new Date().toISOString();}
  if(await this.needsLogin(s))return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  const readiness=(current.kind==='navigation'||s.pendingReads.size)?await waitForCaptureReady(s):null;
  s.lastReadAction.endedAt=new Date().toISOString();
  return {...await this.snapshot(s),...(readiness?{observationReadiness:readiness}:{})};
 }
 async readVisible(s,{section,offset,limit,contentHash,find}){
  // Reuse the same authenticated, authorised page. No URL, hidden DOM, selector,
  // credential lookup, new HTTP request or executable expression from a model.
  let text;
  if(section==='fields'){const fields=await websiteDOM(s).evaluate(websiteFields,{secretSelector:screenshotSecretSelector,full:true});text=JSON.stringify(fields.map(f=>({...f,value:cleanWebsiteText(f.value,Infinity)})));}
  else text=cleanWebsiteText(await websiteDOM(s).locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];let n;while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest('script,style,noscript,input,textarea,[contenteditable],[hidden],[data-sensitive],[data-agentos-secret]')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t)out.push(t);}return out.join('\n');}),Infinity);
  const hash=createHash('sha256').update(JSON.stringify([s.job.id,s.environment.projectId,s.environment.tier,s.page.url(),section,text])).digest('hex');
  if(contentHash&&contentHash!==hash)throw new BrowserInputError('BROWSER_CONTENT_CHANGED','当前可见内容已变化；保留旧页证据，从offset=0重新读取，不能拼成同一份响应');
  const matchOffset=find?text.indexOf(find,offset):null,begin=find?matchOffset<0?text.length:Math.max(0,matchOffset-Math.min(400,Math.floor(limit/4))):offset;
  const part=text.slice(begin,begin+Math.min(limit,10000)),nextOffset=begin+part.length<text.length?begin+part.length:null,nextMatchOffset=find&&matchOffset>=0?text.indexOf(find,matchOffset+find.length):null;
  return {section,url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),contentHash:hash,offset:begin,text:part,...(find?{matchOffset,nextMatchOffset:nextMatchOffset<0?null:nextMatchOffset,literalMatchOnly:true}:{}),totalCharacters:text.length,nextOffset,endOfContent:nextOffset===null,complete:begin===0&&nextOffset===null,note:'仅当前已授权页面的可见脱敏内容，分页不是历史快照；沿contentHash和nextOffset续读，变化时重新开始。无新的业务请求或写入。'};
 }
 async snapshot(s){
  if(s.hoverTooltip&&!await s.hoverTooltip.element.evaluate(el=>el.isConnected).catch(()=>false)){for(const h of [s.hoverTooltip.element,s.hoverTooltip.tooltip])await h.dispose().catch(()=>{});s.hoverTooltip=null;}
  await Promise.allSettled([...s.refs.values()].map(r=>r.el.dispose()));s.refs.clear();s.generation++;
  const text=await websiteDOM(s).locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];let n;while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest('script,style,noscript,input,textarea,[contenteditable],[hidden],[data-sensitive],[data-agentos-secret]')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t)out.push(t);}return out.join('\n');});
  const handles=await websiteDOM(s).locator([websiteControls,...(s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readNavigationSelectors??[])].join(',')).filter({visible:true}).elementHandles();
  const metadata=await websiteDOM(s).evaluate(controlMetadataBatch,{elements:handles,limit:300,options:readControlOptions(s)});
  const controls=[];
  for(const [i,el]of handles.entries()){
   const info=controls.length<300?metadata[i]:null;
   if(!info?.type||info.blocked){await el.dispose();continue;}
   const label=cleanWebsiteText(info.label).slice(0,100),ref=`${s.refPrefix}-${s.generation}-${i}`;
   s.refs.set(ref,{el,type:info.type,kind:info.kind,rawLabel:info.label,linkHref:info.linkHref});controls.push({ref,type:info.type,label,kind:info.kind,...(info.options?{options:info.options}:{})});
  }
  const fields=await websiteDOM(s).evaluate(websiteFields,{secretSelector:screenshotSecretSelector});
  const loading=!text.trim()||s.pendingReads.size>0||await websiteDOM(s).locator('[aria-busy="true"],.el-loading-mask,.ant-spin-spinning,[role="progressbar"]').evaluateAll(xs=>xs.some(x=>x.getClientRects().length&&getComputedStyle(x).visibility!=='hidden'));
  return {stage:'已读取业务网页',pageStatus:loading?'loading':'ready',loading,...pendingWebsiteReads(s),action:websiteActionDiagnostics(s,s.lastReadAction),controlsLimited:controls.length>=300,url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),pageText:cleanWebsiteText(text),fields:fields.slice(0,100),fieldsLimited:fields.length>100,controls,blockedRequests:[...s.blocked].slice(-10),rows:[],note:'来自当前网页；菜单可通过read-action展开；仅当前引用有效。异步列表尚在加载或截图出现新内容后，应使用最新快照的控件，不沿用加载前清单判断按钮缺失。'};
 }
 async screenshot(s,args={}){
  if(!/^[A-Za-z0-9_-]+$/.test(s.job.id))throw new Error('Invalid evidence job');
  const prd=Boolean(s.job.prd?.auto), dom=websiteDOM(s);
  const pageUrl=()=>websitePageLocation(dom.url());
  if(prd&&(!args.targetText||args.url!==pageUrl()))throw new BrowserInputError('BROWSER_ARGUMENTS','请先打开目标页面，传入当前快照的url及详情区标题targetText。');
  const readiness=await waitForCaptureReady(s);
  const login=await this.loginStatus(s);
  if(login.loginRequired)return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  if(login.loginState==='access_denied')return {partial:true,pageStatus:'access_denied',stage:'站点拒绝访问，未保存业务截图',rows:[]};
  if(prd&&readiness.status!=='ready')return {partial:true,stage:'页面尚未稳定，未保存视觉基线',rows:[]};
  const dir=path.join(this.evidenceRoot,s.job.id);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.evidenceRoot,0o700);await chmod(dir,0o700);
  const name=randomUUID()+'.png',file=path.join(dir,name);
  if (prd) {
   const targetVisible=async()=>{
    if(pageUrl()!==args.url)return false;
    const bounds=await s.page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    for(const target of await dom.getByText(args.targetText,{exact:true}).all()){
     const box=await target.boundingBox();
     if(box&&box.width&&box.height&&box.x<bounds.width&&box.y<bounds.height&&box.x+box.width>0&&box.y+box.height>0)return true;
    }
    return false;
   };
   if(!await targetVisible())throw new BrowserInputError('BROWSER_CONTENT_CHANGED','未在当前视口看到目标标题，请打开目标详情、弹窗或模块后重新截图。');
   const style = '*, *::before, *::after {color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;background-image:none!important;list-style-image:none!important} img, svg, canvas, video, object, embed {visibility:hidden!important}';
   const options={path:file,type:'png',timeout:10000,style,animations:'disabled',
    mask:[dom.locator(screenshotSecretSelector),dom.locator('iframe,frame')],maskColor:'#6b7280'};
   const frameElement=s.dom?await s.dom.frameElement():null;
   let pixels, layout, labelAttribute;
   try {
    labelAttribute = s.job.prd.inlinePrototypes ? 'data-agentos-label-'+randomUUID() : null;
    layout = await dom.evaluate(describePrdCapture,{attribute:labelAttribute,secretSelector:screenshotSecretSelector,
     brandedLabels:[s.environment?.displayName].filter(Boolean)});
    if(layout.tableCapture?.tables&&!layout.tableCapture.visibleRows&&!args.emptyState){
     return {...await this.snapshot(s),partial:true,pageStatus:'list_requires_rows',tableCapture:layout.tableCapture,
      stage:'列表尚无实际数据行。先使用当前只读筛选及查询控件取得结果，再截图。若明确要展示空状态，使用 emptyState=true。'};
    }
    if (labelAttribute) {
     for(const [index,sample] of layout.samples.entries()){
      const selector=`[${labelAttribute}-sample="${index}"]`;
      options.style+=`${selector}{position:relative!important}${selector}::after{content:${JSON.stringify(sample.text)}!important;position:absolute!important;left:${sample.left}px;top:${sample.top}px;max-width:calc(100% - ${sample.left}px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;color:${sample.color}!important;-webkit-text-fill-color:${sample.ink}!important}`;
     }
     for (const [index,control] of layout.controls.entries()) {
      const selector=`[${labelAttribute}="${index}"]`;
      options.style+=`${selector}{color:${control.color}!important;-webkit-text-fill-color:${control.ink}!important}`;
     }
     for(const [index,color] of layout.placeholders.entries())options.style+=
      `[${labelAttribute}-placeholder="${index}"]::placeholder{color:${color}!important;-webkit-text-fill-color:${color}!important}`;
     for(const [index,color] of layout.assets.entries()){
      const selector=`[${labelAttribute}-asset="${index}"]`;
      options.style+=`${selector}{visibility:visible!important;color:${color}!important}${selector} *{color:inherit!important}`;
     }
     for(const [index,url] of layout.backgrounds.entries())options.style+=
      `[${labelAttribute}-background="${index}"]{background-image:url(${JSON.stringify(url)})!important}`;
     for(const [index,color] of layout.glyphs.entries())options.style+=
      `[${labelAttribute}-glyph="${index}"]::before{color:${color}!important;-webkit-text-fill-color:${color}!important}`;
    }
    pixels=await (frameElement?frameElement.screenshot(options):s.page.screenshot(options));
   }
   finally{
    if(labelAttribute)await dom.evaluate(attribute=>{
     for(const name of [attribute,attribute+'-asset',attribute+'-placeholder',attribute+'-glyph',attribute+'-background',attribute+'-sample'])
      for(const element of document.querySelectorAll('['+name+']'))element.removeAttribute(name);
    },labelAttribute).catch(()=>{});
    await frameElement?.dispose();
   }
   await chmod(file,0o600);
   if(!await targetVisible().catch(()=>false)){await rm(file,{force:true});throw new BrowserInputError('BROWSER_CONTENT_CHANGED','截图期间目标已变化，请重新打开目标界面。');}
   return {designReference:{name,sha256:createHash('sha256').update(pixels).digest('hex'),bytes:pixels.length,
    capturedAt:new Date().toISOString(),pageUrl:args.url,visualPolicy:'brand-layout-v6',brandRegions:layout.brandRegions,actionRegions:layout.actionRegions,tableCapture:layout.tableCapture},designLayout:layout,rows:[],stage:'已截取真实目标页面脱敏截图，designLayout 提供实际视口及结构坐标'};
  }
  const buffer=await s.page.screenshot({path:file,type:'png',fullPage:false,timeout:10000,mask:s.page.frames().map(frame=>frame.locator(screenshotSecretSelector)),maskColor:'#6b7280',...(readiness.status==='ready'?{}:{style:'body::after{content:"页面加载尚未完成 · 现场截图";position:fixed;top:8px;right:12px;z-index:2147483647;background:#fff3cd;color:#704d00;padding:6px 10px;border:1px solid #e6ce81;border-radius:4px;font:13px sans-serif;pointer-events:none}'})});await chmod(file,0o600);
  return {...await this.snapshot(s),...(readiness.status==='ready'?{}:{pageStatus:'loading',partial:true}),stage:readiness.status==='ready'?'已保存稳定网页截图':'已保存加载未完成的现场截图',screenshot:{name,sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,capturedAt:new Date().toISOString(),url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),readiness},rows:[],note:'已等待接口、加载指示和页面稳定；正常业务字段保留，凭据及显式敏感区用灰色遮挡。readiness.status为ready仅代表渲染稳定，不代表业务正常；其它状态是加载未完成的现场证据。截图由控制服务校验后发送原话题，不能代替未打开页面的检查。'};
 }
 async release(id){const s=this.pages.get(id);this.pages.delete(id);await s?.page.close().catch(()=>{});}
 async close(){await Promise.allSettled([...this.contexts.values()].map(s=>s.context.close()));this.contexts.clear();this.pages.clear();}
}
