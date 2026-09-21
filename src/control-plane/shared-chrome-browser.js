import {randomUUID} from 'node:crypto';
import {chromeTransport} from './chrome-transport.js';
import {chromePage} from './chrome-page.js';
import {chromeLoginPage} from './chrome-login-page.js';
import {cleanWebsiteText,websiteUrl} from '../shared/website-policy.js';
export class SharedChromeBrowser{
 constructor(authorize=async()=>true,transport=chromeTransport){this.authorize=authorize;this.transport=transport;this.pages=new Map();this.queue=Promise.resolve();}
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async allowed(job,e,waiting=false){
  const r={url:()=>websiteUrl(e.baseUrl),method:()=> 'GET',resourceType:()=> 'document'};
  if(!await this.authorize(job,waiting,r))throw new Error('当前问题没有有效网页访问授权');
 }
 async state(job,e){
  let s=this.pages.get(job.id);if(s){if(s.baseUrl!==websiteUrl(e.baseUrl))throw new Error('任务入口已变化，需要重新申请');return s;}
  const tab=await this.transport({operation:'find',baseUrl:websiteUrl(e.baseUrl),exclude:[...this.pages.values()].map(s=>s.tabId)});
  s={...tab,token:randomUUID().replaceAll('-',''),baseUrl:websiteUrl(e.baseUrl),waiting:false};this.pages.set(job.id,s);return s;
 }
 async snapshot(job,e,s,tool,args){
  await this.allowed(job,e,s.waiting);
  const request={baseUrl:s.baseUrl,token:s.token,tool,args};
  const raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${chromePage.toString()})(${JSON.stringify(request)}))`});
  if(raw.error)throw new Error(raw.error);
  s.waiting=raw.loginRequired===true;if(!s.waiting)s.credentialAttempted=false;
  if(raw.pageText)raw.pageText=cleanWebsiteText(raw.pageText);
  if(raw.controls)raw.controls=raw.controls.map(c=>({...c,label:cleanWebsiteText(c.label),...(c.options?{options:c.options.map(o=>({...o,label:cleanWebsiteText(o.label)}))}:{})}));
  return raw;
 }
 run(job,e,tool,args={}){return this.serial(async()=>{
  if(!['connection','browser_open','browser_snapshot','browser_click','browser_search','browser_select'].includes(tool))throw new Error('未开放该网页操作');
  await this.allowed(job,e);const s=await this.state(job,e);
  let r=await this.snapshot(job,e,s,tool,args);
  if(r.acted)r=await this.snapshot(job,e,s,'browser_snapshot',{});
  if(r.loginRequired)await this.transport({operation:'focus',tabId:s.tabId,windowId:s.windowId});
  return r;
 });}
 health(){return this.serial(()=>this.transport({operation:'health',timeoutMs:5000}));}
 async submitCredentials(job,e,cred,{force=false}={}){return this.serial(async()=>{
  await this.allowed(job,e,true);const s=await this.state(job,e);
  if(s.credentialAttempted&&!force)return {authenticated:false,attempted:false};
  s.credentialAttempted=true;
  const request={baseUrl:s.baseUrl,username:cred.username,password:cred.password};
  const raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${chromeLoginPage.toString()})(${JSON.stringify(request)}))`});
  if(raw.error)throw new Error(raw.error);
  if(!raw.submitted&&!raw.loginRequired){s.waiting=false;s.credentialAttempted=false;return {authenticated:true,attempted:false};}
  await new Promise(resolve=>setTimeout(resolve,1200));
  const status=await this.snapshot(job,e,s,'browser_snapshot',{});
  return {authenticated:!status.loginRequired,attempted:true,
   credentialRejected:status.loginRequired===true&&status.credentialFormVisible===true,
   verificationRequired:status.loginRequired===true&&status.verificationRequired===true};
 });}
 loginReady(job,e){return this.serial(async()=>{await this.allowed(job,e,true);const s=await this.state(job,e);return !(await this.snapshot(job,e,s,'browser_snapshot',{})).loginRequired;});}
 async release(id){this.pages.delete(id);}
 async close(){this.pages.clear();} // Never close or quit the user's browser.
}
