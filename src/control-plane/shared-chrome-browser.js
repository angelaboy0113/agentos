import {chromeFrameDocument} from './website-frames.js';
import {BrowserInputError} from '../shared/browser-tool-input.js';
import {validateBrowserTool} from '../shared/browser-tool-input.js';
import {readWebsiteAsset} from './website-assets.js';
import {controlMetadata} from '../shared/website-controls.js';
import {inspectWebsiteControl} from '../shared/website-control-inspection.js';
import {loginNavigationPage,validateLoginNavigation} from '../shared/login-navigation.js';
import {browserLoginState} from '../shared/browser-login-state.js';
import {randomUUID} from 'node:crypto';
import {chromeTransport} from './chrome-transport.js';
import {chromePage} from './chrome-page.js';
import {chromeLoginPage} from './chrome-login-page.js';
import {cleanWebsiteText,websiteUrl,websiteNavigationTarget} from '../shared/website-policy.js';
export class SharedChromeBrowser{
 constructor(authorize=async()=>true,transport=chromeTransport,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){this.wait=wait;this.authorize=authorize;this.transport=transport;this.pages=new Map();this.sessions=new Map();this.queue=Promise.resolve();}
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async allowed(job,e,waiting=false){
  const r={url:()=>websiteUrl(e.baseUrl),method:()=> 'GET',resourceType:()=> 'document'};
  if(!await this.authorize(job,waiting,r))throw new Error('当前问题没有有效网页访问授权');
 }
 async state(job,e){
  const now=Date.now();for(const [key,value] of this.sessions)if(value.releasedAt&&now-value.releasedAt>6*60*60*1000)this.sessions.delete(key);
  let s=this.pages.get(job.id);if(s){if(s.baseUrl!==websiteUrl(e.baseUrl))throw new Error('任务入口已变化，需要重新申请');return s;}
  const lineage=[job.questionId??job.id,job.originProfile,job.projectId,e.tier,websiteUrl(e.baseUrl)].map(v=>String(v??'')).join('\u0000');
  s=this.sessions.get(lineage);if(s){try{const status=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:'JSON.stringify({blank:location.href==="about:blank"})'});if(status.blank){const target=websiteNavigationTarget(job.environmentAccess?.websiteTarget??e.baseUrl,e.baseUrl);await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`location.assign(${JSON.stringify(target)});JSON.stringify({recovering:true})`});await this.wait(400);}delete s.releasedAt;this.pages.set(job.id,s);return s;}catch(error){if(!/原Chrome标签页已关闭/.test(error.message))throw error;this.sessions.delete(lineage);}}
  const tab=await this.transport({operation:'find',baseUrl:websiteUrl(e.baseUrl),exclude:[...this.sessions.values()].map(s=>s.tabId)});
  s={...tab,token:randomUUID().replaceAll('-',''),baseUrl:websiteUrl(e.baseUrl),waiting:false,lineage};this.pages.set(job.id,s);this.sessions.set(lineage,s);return s;
 }
 async snapshot(job,e,s,tool,args){
  await this.allowed(job,e,s.waiting);
  const request={baseUrl:s.baseUrl,token:s.token,tool,args};
  const raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`(()=>{const selected=(${chromeFrameDocument.toString()})(${JSON.stringify(request)});if(selected.result)return JSON.stringify(selected.result);return JSON.stringify({...(${chromePage.toString()})(${JSON.stringify(request)},{document:selected.document,metadata:${controlMetadata.toString()},inspect:${inspectWebsiteControl.toString()}}),...(${browserLoginState.toString()})(selected.document)})})()`});
  if(raw.error){if(raw.code)throw new BrowserInputError(raw.code,raw.error);throw new Error(raw.error);}
  s.waiting=raw.loginRequired===true||raw.loginState==='loading';if(!s.waiting)s.credentialAttempted=false;
  if(raw.pageText)raw.pageText=cleanWebsiteText(raw.pageText);
  if(raw.controls)raw.controls=raw.controls.map(c=>({...c,label:cleanWebsiteText(c.label),...(c.options?{options:c.options.map(o=>({...o,label:cleanWebsiteText(o.label)}))}:{})}));
  return raw;
 }
 run(job,e,tool,args={}){return this.serial(async()=>{
  if(!['connection','browser_open','browser_snapshot','browser_inspect','browser_assets','browser_frames','browser_frame','browser_recover','browser_click','browser_search','browser_select'].includes(tool))throw new Error('未开放该网页操作');
  if(['browser_frames','browser_frame'].includes(tool))validateBrowserTool(tool,args);
  await this.allowed(job,e);const s=await this.state(job,e);
  if(tool==='browser_recover'){
   validateBrowserTool(tool,args);let status;try{status=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:'JSON.stringify({blank:location.href==="about:blank",url:location.origin+location.pathname})'});}catch(error){if(!/原Chrome标签页已关闭/.test(error.message))throw error;this.pages.delete(job.id);const reopened=await this.state(job,e);return this.snapshot(job,e,reopened,'browser_snapshot',{});}
   if(status.blank){const target=websiteNavigationTarget(job.environmentAccess?.websiteTarget??e.baseUrl,e.baseUrl);await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`location.assign(${JSON.stringify(target)});JSON.stringify({recovering:true})`});await this.wait(400);}
   return this.snapshot(job,e,s,'browser_snapshot',{});
  }
  if(tool==='browser_assets')validateBrowserTool(tool,args);
  if(tool==='browser_assets')return readWebsiteAsset({...s,assets:s.assets??(s.assets=new Map()),job,environment:e,page:{locator:()=>({evaluateAll:fn=>this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${fn.toString()})(Array.from(document.querySelectorAll('script[src]'))))`})})}},args,this.authorize);
  let r=await this.snapshot(job,e,s,tool,args);
  if(r.acted)r=await this.snapshot(job,e,s,'browser_snapshot',{});
  for(let attempt=0;attempt<3&&['empty','loading'].includes(r.pageStatus);attempt++){await this.wait(400);r=await this.snapshot(job,e,s,'browser_snapshot',{});}
  if(r.loginRequired)await this.transport({operation:'focus',tabId:s.tabId,windowId:s.windowId});
  return r;
 });}
 health(){return this.serial(()=>this.transport({operation:'health',timeoutMs:5000}));}
 async submitCredentials(job,e,cred,{force=false}={}){return this.serial(async()=>{
  await this.allowed(job,e,true);const s=await this.state(job,e);
  if(s.credentialAttempted&&!force)return {authenticated:false,attempted:false};
  if(e.loginNavigation){const status=await this.snapshot(job,e,s,'browser_snapshot',{});if(status.pageReady===true&&!status.loginRequired)return {...status,authenticated:true,attempted:false};const navigation=validateLoginNavigation(e.loginNavigation);for(const step of navigation.steps){const request={baseUrl:s.baseUrl,usernameLabel:navigation.usernameLabel,entryUrl:navigation.entryUrl,step};const result=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${loginNavigationPage.toString()})(${JSON.stringify(request)}))`});if(result.error)throw Error(result.error);if(result.ready)break;await this.wait(150);}const result=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${loginNavigationPage.toString()})(${JSON.stringify({baseUrl:s.baseUrl,usernameLabel:navigation.usernameLabel})}))`});if(!result.ready)throw Error(result.error??'登录账号身份入口尚未就绪，未填写凭据');}
  s.credentialAttempted=true;
  const request={baseUrl:s.baseUrl,username:cred.username,password:cred.password};
  const raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${chromeLoginPage.toString()})(${JSON.stringify(request)}))`});
  if(raw.error)throw new Error(raw.error);
  await new Promise(resolve=>setTimeout(resolve,1200));
  const status=await this.snapshot(job,e,s,'browser_snapshot',{});
  return {...status,authenticated:status.pageReady===true&&!status.loginRequired,attempted:raw.submitted===true,credentialRejected:status.credentialRejected===true,verificationRequired:status.verificationRequired===true};
 });}
 loginReady(job,e){return this.serial(async()=>{await this.allowed(job,e,true);const s=await this.state(job,e);return (await this.snapshot(job,e,s,'browser_snapshot',{})).pageReady===true;});}
 loginStatusFor(job,e){return this.serial(async()=>{await this.allowed(job,e,true);const s=await this.state(job,e);return this.snapshot(job,e,s,'browser_snapshot',{});});}
 async release(id){const session=this.pages.get(id);this.pages.delete(id);if(session)session.releasedAt=Date.now();} // Keep the scoped lineage session for a continuation job.
 async close(){this.pages.clear();this.sessions.clear();} // Never close or quit the user's browser.
}
