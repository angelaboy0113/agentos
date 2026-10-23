import {browserLoginState,authResponseState} from '../shared/browser-login-state.js';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { websiteSessionKey, websiteRequestAllowed, writeAction, cleanWebsiteText } from '../shared/website-policy.js';
// One private profile per project/environment/origin. Pages and refs remain per question/job.
export class WebsiteBrowser {
 constructor(dataDir, driver=chromium, authorize=async()=>true){this.authorize=authorize;this.root=path.join(dataDir,'website-sessions');this.driver=driver;this.contexts=new Map();this.pages=new Map();this.opening=new Map();}
 async session(e) {
  const key=websiteSessionKey(e.projectId,e.tier,e.baseUrl);
  if(this.contexts.has(key))return this.contexts.get(key);
  if(this.opening.has(key))return this.opening.get(key);
  const p=(async()=>{
   const dir=path.join(this.root,key);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.root,0o700);await chmod(dir,0o700);
   const context=await this.driver.launchPersistentContext(dir,{headless:false,acceptDownloads:false,serviceWorkers:'block',locale:'zh-CN',args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
   const session={context,e};this.contexts.set(key,session);
   await context.routeWebSocket('**/*',s=>s.close());
   await context.addInitScript(()=>{for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport'])Object.defineProperty(window,key,{value:undefined,configurable:false});});
   await context.route('**/*',async route=>{
    const r=route.request();let page;try{page=r.frame().page();}catch{}
    const state=[...this.pages.values()].find(s=>s.page===page);
    let allow=false;try{allow=websiteRequestAllowed(e.baseUrl,{url:r.url(),method:r.method(),body:r.postData(),resourceType:r.resourceType()},state?.waiting===true);}catch{}
    if(allow&&!state)allow=false;
    if(allow&&state) {try{allow=await this.authorize(state.job,state.waiting,r);}catch{allow=false;}}
    if(!allow){if(state){state.blocked.add(`${r.method()} ${new URL(r.url()).pathname}`);if(['xhr','fetch'].includes(r.resourceType())&&new URL(r.url()).origin===new URL(e.baseUrl).origin)state.blockedLoginReads.add(`${r.method()} ${new URL(r.url()).pathname}`);}await route.abort().catch(()=>{});return;}
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  if(this.pages.has(job.id))return this.pages.get(job.id);
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,refPrefix:randomUUID(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set(),blockedLoginReads:new Set()};this.pages.set(job.id,s);
  page.on('response',async response=>{
   const req=response.request();if(req.method()!=='POST'||!/\/(?:login|signin|sign-in|authenticate|auth|token)(?:[/?#]|$)/i.test(new URL(response.url()).pathname))return;
   if(new URL(response.url()).origin!==new URL(e.baseUrl).origin)return;
   s.authPostSeen=true;try{s.authResult=authResponseState(response.status(),await response.json());}catch{s.authResult=authResponseState(response.status(),null);}
  });
  page.setDefaultTimeout(10000);page.on('download',d=>d.cancel().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));page.on('dialog',d=>d.dismiss().catch(()=>{}));
  try{await page.goto(e.baseUrl,{waitUntil:'domcontentloaded',timeout:30000});}catch(error){await this.release(job.id);throw error;}
  return s;
 }
 async loginStatus(s){
  const state=await s.page.evaluate(browserLoginState);
  if(state.loginRequired&&s.authResult&&!state.verificationRequired&&!state.passwordChangeRequired)Object.assign(state,s.authResult);
  if(state.loginRequired){s.waiting=true;s.sawLogin=true;}
  else if(state.pageReady){if(s.waiting&&s.sawLogin)s.reloadAfterLogin=true;s.waiting=false;}
  if(s.blockedLoginReads.size&&state.loginRequired&&!state.credentialRejected)state.blockedRequests=[...s.blockedLoginReads].slice(-8);
  return state;
 }
 async needsLogin(s){const state=await this.loginStatus(s);return state.loginRequired||!state.pageReady;}
 async loginStatusFor(job,e){return this.loginStatus(await this.state(job,e));}
 async loginReady(job,e){const s=await this.state(job,e);return (await this.loginStatus(s)).pageReady===true;}
 async submitCredentials(job,e,cred,{force=false}={}){
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw new Error('当前任务没有有效网站登录范围');
  const s=await this.state(job,e);
  const current=new URL(s.page.url()),base=new URL(e.baseUrl),prefix=base.pathname.replace(/\/$/,'');
  const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash);
  if(current.origin!==base.origin||(!authPath&&!(current.pathname===prefix||current.pathname.startsWith(prefix+'/'))))throw new Error('浏览器已离开本次批准的登录范围');
  if(s.credentialAttempted&&!force)return {...await this.loginStatus(s),authenticated:false,attempted:false};
  const before=await this.loginStatus(s);
  if(before.passwordChangeRequired)return {...before,authenticated:false,attempted:false};
  const password=s.page.locator('input[type="password"]:visible').first();
  if(!await password.count())return {...before,authenticated:before.pageReady===true,attempted:false};
  s.credentialAttempted=true;s.authResult=null;s.authPostSeen=false;s.blockedLoginReads.clear();
  const form=password.locator('xpath=ancestor::form[1]');const scope=await form.count()?form:s.page.locator('body');
  const inputs=scope.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):visible');
  let username=inputs.first();for(let i=0;i<await inputs.count();i++){const el=inputs.nth(i);const label=await el.evaluate(x=>[x.name,x.id,x.autocomplete,x.placeholder,x.getAttribute('aria-label')].join(' '));if(/user|account|login|email|phone|mobile|账号|用户|邮箱|手机/i.test(label)){username=el;break;}}
  if(await username.count())await username.fill(cred.username);
  await password.fill(cred.password);
  if(before.verificationRequired)return {...before,authenticated:false,attempted:false};
  const named=scope.getByRole('button',{name:/^(?:登\s*录|登\s*入|sign\s*in|log\s*in|submit|确定|继续)$/i}).first();
  const submit=await named.count()?named:scope.locator('button[type="submit"]:visible,input[type="submit"]:visible').first();
  if(await submit.count())await submit.click();else return {...before,authenticated:false,attempted:false,credentialRejected:false,submissionUnconfirmed:true,loginState:'submission_control_missing'};
  await s.page.waitForTimeout(1200);const status=await this.loginStatus(s);
  if(status.pageReady)s.credentialAttempted=false;
  return {...status,authenticated:status.pageReady===true,attempted:true,submissionUnconfirmed:!s.authPostSeen&&status.loginRequired};
 }
 async run(job,e,tool,args={}) {
  const s=await this.state(job,e);
  const login=await this.loginStatus(s);
  if(login.loginRequired){await s.page.bringToFront();return {loginRequired:true,stage:'等待本机登录',message:'已在运行AgentOS的电脑上打开登录页面；登录后自动继续原问题，无需回复继续。'};}
  if(!login.pageReady)return {stage:'页面尚未就绪',pageStatus:'loading',partial:true,pageText:'',controls:[],message:'尚未取得可见业务内容，不能认定登录成功或页面正常。'};
  if(s.reloadAfterLogin){s.reloadAfterLogin=false;await s.page.reload({waitUntil:'domcontentloaded'});}
  if(tool==='connection'||tool==='browser_open'||tool==='browser_snapshot')return this.snapshot(s);
  const ref=s.refs.get(args.ref);if(!ref)throw new Error('页面引用过期，请重新获取browser_snapshot');
  if(writeAction.test(await ref.el.innerText().catch(()=>'')))throw new Error('该操作可能改变业务状态，需要单独授权，本次未执行');
  if(tool==='browser_search'&&ref.type==='search'&&typeof args.text==='string'&&args.text.length<=200){await ref.el.fill(args.text);}
  else if(tool==='browser_select'&&ref.type==='select'&&typeof args.value==='string'&&args.value.length<=200){await ref.el.selectOption(args.value);}
  else if(tool==='browser_click'&&ref.type==='read-action'){await ref.el.click();await s.page.waitForLoadState('domcontentloaded').catch(()=>{});}
  else throw new Error('未开放该网页操作');
  if(await this.needsLogin(s))return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  return this.snapshot(s);
 }
 async snapshot(s){
  s.refs.clear();s.generation++;
  const text=await s.page.locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];let n;while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest('script,style,noscript,input,textarea,[contenteditable],[hidden]')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t)out.push(t);}return out.join('\n');});
  const loc=s.page.locator('a,[role="link"],button,select,[role="button"],input:not([type="password"]):not([type="hidden"]),tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]');const controls=[];
  for(let i=0,n=Math.min(await loc.count(),150);i<n;i++){
   const el=loc.nth(i);if(!await el.isVisible()||!await el.isEnabled())continue;
   const tag=await el.evaluate(x=>x.tagName.toLowerCase());const row=await el.evaluate(x=>x.matches('tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]'));
   const rawLabel=cleanWebsiteText((await el.innerText().catch(()=>''))||await el.getAttribute('placeholder')||await el.getAttribute('aria-label')||await el.getAttribute('title')||await el.getAttribute('name')||await el.getAttribute('id')||'').trim().slice(0,100);const label=row&&rawLabel?`行详情：${rawLabel}`:rawLabel;
   if(!label||writeAction.test(label))continue;
   if(tag==='input'&&!/搜索|查询|日期|时间|名称|编号|search|filter|date|name|id/i.test(label))continue;
   // Expose navigation, view, search and pagination controls; unknown effects are not guessed.
   if(tag!=='input'&&tag!=='select'&&tag!=='a'&&!row&&!/查看|详情|日志|查询|搜索|下一页|上一页|刷新|展开|收起|确定|search|query|view|detail|log|next|previous|refresh/i.test(label))continue;
   const ref=`${s.refPrefix}-${s.generation}-${i}`,type=tag==='input'?'search':tag==='select'?'select':'read-action';s.refs.set(ref,{el,type});controls.push({ref,type,label,...(tag==='select'?{options:await el.locator('option').evaluateAll(xs=>xs.slice(0,100).map(x=>({value:x.value,label:x.textContent})))}:{})});
  }
  return {stage:'已读取业务网页',url:new URL(s.page.url()).origin+new URL(s.page.url()).pathname,pageText:cleanWebsiteText(text),controls,blockedRequests:[...s.blocked].slice(-10),rows:[],note:'来自当前网页；不代表任务已执行或数据已修改。'};
 }
 async release(id){const s=this.pages.get(id);this.pages.delete(id);await s?.page.close().catch(()=>{});}
 async close(){await Promise.allSettled([...this.contexts.values()].map(s=>s.context.close()));this.contexts.clear();this.pages.clear();}
}
