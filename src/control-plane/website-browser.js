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
    if(!allow){if(state)state.blocked.add(`${r.method()} ${new URL(r.url()).pathname}`);await route.abort().catch(()=>{});return;}
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  if(this.pages.has(job.id))return this.pages.get(job.id);
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,refPrefix:randomUUID(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set()};this.pages.set(job.id,s);
  page.setDefaultTimeout(10000);page.on('download',d=>d.cancel().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));page.on('dialog',d=>d.dismiss().catch(()=>{}));
  try{await page.goto(e.baseUrl,{waitUntil:'domcontentloaded',timeout:30000});}catch(error){await this.release(job.id);throw error;}
  return s;
 }
 async needsLogin(s){
  const password=await s.page.locator('input[type="password"]').first().isVisible().catch(()=>false);
  const login=/\/(?:login|signin)(?:[/?#]|$)/i.test(s.page.url());
  if(password||login){s.waiting=true;s.sawLogin=true;return true;}
  if(s.waiting&&s.sawLogin){s.waiting=false;s.reloadAfterLogin=true;}
  return s.waiting;
 }
 async loginReady(job,e){const s=await this.state(job,e);return !(await this.needsLogin(s));}
 async submitCredentials(job,e,cred,{force=false}={}){const s=await this.state(job,e);if(s.credentialAttempted&&!force)return {authenticated:false,attempted:false};s.credentialAttempted=true;
  const password=s.page.locator('input[type="password"]:visible').first();if(!await password.count()){s.credentialAttempted=false;return {authenticated:true,attempted:false};}
  const form=password.locator('xpath=ancestor::form[1]');const scope=await form.count()?form:s.page.locator('body');
  const username=scope.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):visible').first();if(await username.count())await username.fill(cred.username);
  await password.fill(cred.password);const submit=scope.locator('button[type="submit"],input[type="submit"],button:has-text("登录"),button:has-text("登入")').first();
  if(await submit.count())await submit.click();else await password.press('Enter');await s.page.waitForTimeout(1200);const waiting=await this.needsLogin(s);if(!waiting)s.credentialAttempted=false;return {authenticated:!waiting,attempted:true};}
 async run(job,e,tool,args={}) {
  const s=await this.state(job,e);
  if(await this.needsLogin(s)){await s.page.bringToFront();return {loginRequired:true,stage:'等待本机登录',message:'已在运行AgentOS的电脑上打开登录页面；登录后自动继续原问题，无需回复继续。'};}
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
