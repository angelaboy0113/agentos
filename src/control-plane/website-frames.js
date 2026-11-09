import {randomUUID}from'node:crypto';import{BrowserInputError,websitePageLocation}from'../shared/browser-tool-input.js';import{cleanWebsiteText}from'../shared/website-policy.js';
function allowed(s,frame){try{const u=new URL(frame.url()),base=new URL(s.environment.baseUrl),prefix=base.pathname.replace(/\/$/,'');return u.origin===base.origin&&(u.pathname===prefix||u.pathname.startsWith(prefix+'/'));}catch{return false;}}
async function visibleFrame(s,frame){
 for(let current=frame;current&&current!==s.page.mainFrame();current=current.parentFrame()){
  if(!allowed(s,current)||current.isDetached())return false;let handle;try{handle=await current.frameElement();if(!await handle.evaluate(el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'))return false;}catch{return false;}finally{await handle?.dispose();}
 }
 return true;
}
export async function assertWebsiteFrame(s){if(s.dom&&(!allowed(s,s.dom)||s.dom.isDetached()||!await visibleFrame(s,s.dom)))throw new BrowserInputError('BROWSER_REF_STALE','原内嵌页已隐藏、跳转或移除，重新读取browser_frames；未使用旧引用。');}
export async function websiteFrames(s,ref){
 if(ref){const frame=s.frameRefs?.get(ref);if(!frame||frame.isDetached()||!allowed(s,frame)||!await visibleFrame(s,frame))throw new BrowserInputError('BROWSER_REF_STALE','内嵌页引用已失效或超出原应用范围，重新读取browser_frames。');s.dom=frame;return {selected:true,url:websitePageLocation(frame.url())};}
 s.frameRefs=new Map();const frames=[];
 for(const frame of s.page.frames()){
  if(!allowed(s,frame))continue;
  if(!await visibleFrame(s,frame))continue;
  const id=randomUUID();s.frameRefs.set(id,frame);frames.push({ref:id,main:frame===s.page.mainFrame(),url:websitePageLocation(frame.url()),name:cleanWebsiteText(frame.name()).slice(0,100),selected:s.dom===frame});
 }
 return {frames,excludedFrames:s.page.frames().length-frames.length,note:'仅当前任务原应用范围内可见的主/内嵌页；不读取跨域或隐藏帧。用browser_frame选择后刷新该页控件，旧控件引用不能跨页复用。'};
}
export function websiteDOM(s){const frame=s.dom;if(frame&&(frame.isDetached()||!allowed(s,frame)))throw new BrowserInputError('BROWSER_REF_STALE','已选择的内嵌页已跳转或移除，先browser_frames重新选择。');return frame??s.page;}

// Fixed native Chrome DOM bridge; same-origin frame references, never selectors/URLs from a model.
export function chromeFrameDocument(q){
 const owner=globalThis.window,root=globalThis.document,base=new URL(q.baseUrl),prefix=base.pathname.replace(/\/$/,''),key='__agentos_frames_'+q.token;
 const valid=doc=>{try{const u=new URL(doc.location.href);return u.origin===base.origin&&(u.pathname===prefix||u.pathname.startsWith(prefix+'/'));}catch{return false;}};
 const visible=el=>el.isConnected&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 const state=owner[key]??{refs:{},selected:null,generation:0};owner[key]=state;
 if(q.tool==='browser_frames'){
  state.refs={};state.generation++;const frames=[];
  const add=(doc,chain)=>{if(!valid(doc)||chain.some(x=>!visible(x)))return;const ref=q.token+'-frame-'+state.generation+'-'+frames.length;state.refs[ref]={doc,chain};frames.push({ref,main:doc===root,url:doc.location.origin+doc.location.pathname,name:String(chain.at(-1)?.name??'').slice(0,100)});for(const el of doc.querySelectorAll('iframe,frame')){try{if(visible(el)&&el.contentDocument)add(el.contentDocument,[...chain,el]);}catch{}}};add(root,[]);return {result:{frames,note:'仅当前任务同应用可见内嵌页；不读取隐藏或跨域页面。'}};
 }
 if(q.tool==='browser_frame'){
  const entry=state.refs[q.args.ref];if(!entry||!valid(entry.doc)||entry.chain.some(x=>!visible(x)))return {result:{error:'内嵌页引用已失效，重新browser_frames',code:'BROWSER_REF_STALE'}};
  const previous=state.selected?.doc??root;delete previous.defaultView['__agentos_read_'+q.token];delete entry.doc.defaultView['__agentos_read_'+q.token];state.selected=entry;
 }
 const selected=state.selected;if(selected&&(!valid(selected.doc)||selected.chain.some(x=>!visible(x))))return {result:{error:'原内嵌页已隐藏或跳转，重新browser_frames',code:'BROWSER_REF_STALE'}};
 return {document:selected?.doc??root};
}
