import {browserLoginState,authResponseState} from '../shared/browser-login-state.js';
import { randomUUID,createHash } from 'node:crypto';
import {BrowserInputError,validateBrowserTool,websitePageLocation} from '../shared/browser-tool-input.js';
import { chromium } from 'playwright';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { websiteSessionKey, websiteRequestAllowed, writeAction, cleanWebsiteText } from '../shared/website-policy.js';
// One private profile per project/environment/origin. Pages and refs remain per question/job.
export class WebsiteBrowser {
 constructor(dataDir, driver=chromium, authorize=async()=>true){this.authorize=authorize;this.evidenceRoot=path.join(dataDir,'website-evidence');this.root=path.join(dataDir,'website-sessions');this.driver=driver;this.contexts=new Map();this.pages=new Map();this.opening=new Map();}
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
    const state=[...this.pages.values()].find(s=>s.page===page),target=state?.environment??e;
    let allow=false;try{allow=websiteRequestAllowed(target.baseUrl,{url:r.url(),method:r.method(),body:r.postData(),resourceType:r.resourceType()},state?.waiting===true,target.queries?.[state?.job?.environmentAccess?.queryId]?.readEndpoints??[]);}catch{}
    if(allow&&!state)allow=false;
    if(allow&&state) {try{allow=await this.authorize(state.job,state.waiting,r);}catch{allow=false;}}
    if(!allow){if(state){state.blocked.add(`${r.method()} ${new URL(r.url()).pathname}`);if(['xhr','fetch'].includes(r.resourceType())&&!/\.(?:js|css|map|png|jpe?g|svg|ico|woff2?)(?:$)/i.test(new URL(r.url()).pathname)&&new URL(r.url()).origin===new URL(e.baseUrl).origin)state.blockedLoginReads.add(`${r.method()} ${new URL(r.url()).pathname}`);}await route.abort().catch(()=>{});return;}
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  if(this.pages.has(job.id)){
   const existing=this.pages.get(job.id);
   if(websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(existing.environment.projectId,existing.environment.tier,existing.environment.baseUrl)||e.baseUrl!==existing.environment.baseUrl)await this.release(job.id);
   else {existing.job=job;existing.environment=e;return existing;}
  }
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,environment:e,refPrefix:randomUUID(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set(),blockedLoginReads:new Set()};this.pages.set(job.id,s);
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
  return {...state,diagnostic:{credentialAttempted:s.credentialAttempted===true,authRequestObserved:s.authPostSeen===true,authResult:s.authResult?.loginState??null,blockedRequests:[...s.blockedLoginReads].slice(-8)}};
 }
 async needsLogin(s){const state=await this.loginStatus(s);return state.loginRequired||!state.pageReady;}
 async loginStatusFor(job,e){return this.loginStatus(await this.state(job,e));}
 async loginReady(job,e){const s=await this.state(job,e);return (await this.loginStatus(s)).pageReady===true;}
 async submitCredentials(job,e,cred,{force=false}={}){
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw new Error('当前任务没有有效网站登录范围');
  const opened=this.pages.get(job.id);
  if(opened&&(websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(opened.environment.projectId,opened.environment.tier,opened.environment.baseUrl)||opened.environment.baseUrl!==e.baseUrl))throw new Error('凭据目标与已打开的任务登录范围不一致；本次未导航或填写');
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
  validateBrowserTool(tool,args);
  const s=await this.state(job,e);
  // A ref belongs to one immutable element handle in one page generation, never nth(i).
  const previous=s.operation??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>this.perform(s,tool,args));s.operation=operation;
  try{return await operation;}finally{if(s.operation===operation)s.operation=null;}
 }
 async perform(s,tool,args){
  const login=await this.loginStatus(s);
  if(login.loginRequired){await s.page.bringToFront();return {loginRequired:true,stage:'等待本机登录',message:'登录后自动继续原问题，无需回复继续。'};}
  if(tool==='browser_screenshot')return this.screenshot(s);
  if(!login.pageReady)return {stage:'页面尚未就绪',pageStatus:'loading',url:websitePageLocation(s.page.url()),partial:true,pageText:'',controls:[],message:'尚未取得可见业务内容，不能认定登录成功或页面正常。'};
  if(s.reloadAfterLogin){s.reloadAfterLogin=false;await s.page.reload({waitUntil:'domcontentloaded'});}
  if(tool==='connection'||tool==='browser_open'||tool==='browser_snapshot')return this.snapshot(s);
  const ref=s.refs.get(args.ref);if(!ref)throw new BrowserInputError('BROWSER_REF_STALE','页面引用已过期；先browser_snapshot，再使用新引用。');
  const current=await ref.el.evaluate(controlMetadata).catch(()=>null);
  if(!current||!current.visible)throw new BrowserInputError('BROWSER_REF_STALE','原控件已移除或隐藏；先browser_snapshot，不重复旧操作。');
  if(current.label!==ref.rawLabel||current.type!==ref.type)throw new BrowserInputError('BROWSER_CONTROL_CHANGED','控件内容或用途已改变；重新读取snapshot后选择，不执行原操作。');
  if(writeAction.test(current.label))throw new Error('该操作可能改变业务状态，本次未执行');
  const expected={browser_search:'search',browser_select:'select',browser_click:'read-action'}[tool];
  if(ref.type!==expected)throw new BrowserInputError('BROWSER_CONTROL_TYPE','当前引用不是该工具对应的控件；菜单和详情用browser_click，输入框用browser_search，原生下拉框用browser_select。');
  try{
   if(tool==='browser_search')await ref.el.fill(args.text,{timeout:8000});
   else if(tool==='browser_select')await ref.el.selectOption(args.value,{timeout:8000});
   else await ref.el.click({timeout:8000});
  }catch(error){if(error.name==='TimeoutError')throw new BrowserInputError('BROWSER_OPERATION_TIMEOUT','本次控件操作未确认完成；不要重复点击，先browser_snapshot核对页面是否变化，再决定下一步。不能将工具超时认定为网站故障。');throw error;}
  if(await this.needsLogin(s))return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  return this.snapshot(s);
 }
 async snapshot(s){
  await Promise.allSettled([...s.refs.values()].map(r=>r.el.dispose()));s.refs.clear();s.generation++;
  const text=await s.page.locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];let n;while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest('script,style,noscript,input,textarea,[contenteditable],[hidden]')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t)out.push(t);}return out.join('\n');});
  const handles=await s.page.locator('a,[role="link"],button,select,[role="button"],input:not([type="password"]):not([type="hidden"]),[role="menuitem"],[role="treeitem"],[aria-haspopup="menu"],.el-submenu__title,.ant-menu-submenu-title,tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]').filter({visible:true}).elementHandles();
  const controls=[];
  for(const [i,el]of handles.entries()){
   const info=controls.length<300?await el.evaluate(controlMetadata).catch(()=>null):null;
   if(!info?.type||writeAction.test(info.label)){await el.dispose();continue;}
   const label=cleanWebsiteText(info.label).slice(0,100),ref=`${s.refPrefix}-${s.generation}-${i}`;
   s.refs.set(ref,{el,type:info.type,rawLabel:info.label});controls.push({ref,type:info.type,label,...(info.options?{options:info.options}:{})});
  }
  const loading=await s.page.locator('[aria-busy="true"],.el-loading-mask,.ant-spin-spinning,[role="progressbar"]').evaluateAll(xs=>xs.some(x=>x.getClientRects().length&&getComputedStyle(x).visibility!=='hidden'));
  return {stage:'已读取业务网页',pageStatus:loading?'loading':'ready',loading,controlsLimited:controls.length>=300,url:websitePageLocation(s.page.url()),pageText:cleanWebsiteText(text),controls,blockedRequests:[...s.blocked].slice(-10),rows:[],note:'来自当前网页；菜单可通过read-action展开；仅当前引用有效。异步列表尚在加载或截图出现新内容后，应使用最新快照的控件，不沿用加载前清单判断按钮缺失。'};
 }
 async screenshot(s){
  if(!/^[A-Za-z0-9_-]+$/.test(s.job.id))throw new Error('Invalid evidence job');
  const dir=path.join(this.evidenceRoot,s.job.id);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.evidenceRoot,0o700);await chmod(dir,0o700);
  const name=randomUUID()+'.png',file=path.join(dir,name);
  const buffer=await s.page.screenshot({path:file,type:'png',fullPage:false,timeout:10000,mask:[s.page.locator('input,textarea,[contenteditable="true"],[data-sensitive]')]});await chmod(file,0o600);
  return {...await this.snapshot(s),stage:'已保存当前网页截图',screenshot:{name,sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,capturedAt:new Date().toISOString(),url:websitePageLocation(s.page.url())},rows:[],note:'当前视口截图；输入框已遮挡。截图由控制服务校验后发送原话题，不能代替未打开页面的检查。'};
 }
 async release(id){const s=this.pages.get(id);this.pages.delete(id);await s?.page.close().catch(()=>{});}
 async close(){await Promise.allSettled([...this.contexts.values()].map(s=>s.context.close()));this.contexts.clear();this.pages.clear();}
}

// Runs on a concrete DOM element: synchronous reads never auto-wait for input.innerText.
export function controlMetadata(el){
 const visible=el.isConnected&&!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 if(!visible||el.disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[contenteditable="true"]'))return {visible:false};
 const tag=el.tagName.toLowerCase(),row=el.matches('tr[data-row-key],[role="row"][data-row-key],.ant-table-row[data-row-key]');
 const title=el.matches('[role="menuitem"],[role="treeitem"]')?el.querySelector(':scope > .el-submenu__title,:scope > .ant-menu-submenu-title'):null;
 const label=((title??el).innerText||el.getAttribute('placeholder')||el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('name')||el.id||'').trim().slice(0,100);
 if(!label)return {visible:true,label,type:null};
 let type=null;
 if(tag==='input'){if(!el.readOnly&&/^(text|search|date|datetime-local|number|month|week|time|tel)$/.test(el.type)&&/搜索|查询|日期|时间|名称|编号|search|filter|date|name|id/i.test(label))type='search';}
 else if(tag==='select')type='select';
 else if(tag==='a'||row||el.matches('[role="menuitem"],[role="treeitem"],[aria-haspopup="menu"],.el-submenu__title,.ant-menu-submenu-title')||/查看|详情|日志|查询|搜索|下一页|上一页|刷新|展开|收起|确定|search|query|view|detail|log|next|previous|refresh/i.test(label))type='read-action';
 // Avoid duplicating the parent menuitem and its actual submenu title.
 if(title)type=null;
 return {visible:true,label:row?'行详情：'+label:label,type,...(tag==='select'?{options:[...el.options].slice(0,100).map(x=>({value:x.value,label:x.textContent}))}:{})};
}
