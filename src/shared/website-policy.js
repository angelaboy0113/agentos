import {loginPageAllowed} from './website-sso.js';
import {parseExactJson} from './exact-json.js';
import { createHash } from 'node:crypto';
export const writeAction = /新增|创建|保存|修改|编辑|删除|启动|停止|执行一次|立即执行|触发|重跑|重发|重新发送|重放|终止|发布|启用|禁用|提交|审批|支付|注销|退出|\b(add|create|save|update|edit|delete|remove|start|stop|trigger|execute|run|restart|reset|kill|publish|enable|disable|submit|approve|pay|logout|resend|replay)\b/i;
function typedReadParameter(type,value){if(type!=='isoTimestamp'||typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return false;const n=Date.parse(value);return Number.isFinite(n)&&new Date(n).toISOString()===value.replace(/Z$/,value.includes('.')?'Z':'.000Z');}
const reads = /^(?:get|list|page|pageList|query|search|find|detail|view|info|index|home|dashboard|status|log|logs|logDetailCat|logDetailPage|toLogin|login|auth|check|count|select|load|read)[a-z0-9_-]*$/i;
export function websiteUrl(input) {
 const u = new URL(input);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||(u.hostname==='localhost'||u.hostname.endsWith('.localhost'))||/^(127\.|0\.|169\.254\.|\[?::1\]?)/.test(u.hostname)) throw new Error('网页入口必须是不含凭据的业务HTTP(S)地址，不能是本机管理或链路本地地址');
 u.hash=''; return u.toString();
}
// Navigation is task scope, not an application identity or credential key.
export function websiteNavigationTarget(input,base,readEndpoints=[]) {
 const reject=()=>Object.assign(new Error('网页目标地址未通过只读校验'),{code:'BROWSER_NAVIGATION_SCOPE',statusCode:400,queryDiagnostic:{code:'WEBSITE_TARGET_INVALID',reason:'本次页面地址无效、含凭据/写操作，或超出原应用范围。',correction:'使用源码、实际菜单或页面证据中的同应用只读地址；保留经销商、期间等筛选参数，不传账号、令牌或操作指令。'}});
 try {
  const u=new URL(input),entry=new URL(u);if(/[\x00-\x20\x7f]/.test(String(input)))throw reject();entry.search='';entry.hash='';websiteUrl(entry.href);
  const effective=new URL(u);if(u.hash){if(!u.hash.startsWith('#/'))throw reject();const route=new URL(u.hash.slice(1),u.origin);effective.pathname=route.pathname;effective.search=route.search;effective.hash='';}
  for(const query of [u.searchParams,effective.searchParams])for(const [key]of query)if(/password|passwd|pwd|secret|token|authorization|cookie|credential|api.?key/i.test(key))throw reject();
  for(const url of [u,effective]){const decoded=decodeURIComponent(url.pathname);if(decoded.includes('\\')||decoded.split('/').includes('..')||/%(?:2e|2f|5c)/i.test(decoded))throw reject();}
  for(const url of [u,effective])if(!websiteRequestAllowed(u.origin,{url:url.href,method:'GET',resourceType:'document'},false,readEndpoints))throw reject();
  if(base){const root=new URL(websiteUrl(base)),prefix=root.pathname.replace(/\/$/,'');if(root.origin!==u.origin||!(u.pathname===prefix||u.pathname.startsWith(prefix+'/')))throw reject();}
  return u.href;
 }catch{throw reject();}
}
export function websiteReadRecoveryTarget(input, base, readEndpoints=[]) {
 const target = websiteNavigationTarget(input, base, readEndpoints);
 const url = new URL(target);
 if (target !== input || url.search || url.hash.includes('?') ||
   /(?:^|\/)(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[\/#]|$)/i.test(url.pathname + url.hash)) {
  throw new Error('空白页恢复仅允许本应用固定、无参数的已审核只读业务页');
 }
 return target;
}
export const websiteSessionKey = (project,tier,url) => 'web-'+createHash('sha256').update(JSON.stringify([project,tier,new URL(websiteUrl(url)).origin])).digest('hex').slice(0,24);
// Registration identifies the requested application entry; session storage remains origin-scoped.
export const websiteKey = (project,tier,url) => 'web-entry-'+createHash('sha256').update(JSON.stringify([project,tier,websiteUrl(url)])).digest('hex').slice(0,24);
const readPathIds={hexId:/^[a-f0-9]{32}$/i,objectId:/^[a-f0-9]{24}$/i,uuid:/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,integerId:/^[0-9]{1,20}$/};
// Typed whole-segment identifiers only; no regex, glob, readable action or URL.
export function reviewedPathMatches(pattern,pathname){
 if(typeof pattern!=='string'||typeof pathname!=='string')return false;
 const expected=pattern.split('/'),actual=pathname.split('/');if(expected.length!==actual.length)return false;
 return expected.every((segment,index)=>{const type=/^\{([A-Za-z]+)\}$/.exec(segment)?.[1];return type?Object.hasOwn(readPathIds,type)&&readPathIds[type].test(actual[index]):segment===actual[index];});
}
// A reviewed query may name a business object with a verb inside its compound
// name (e.g. taskExecutionSettings). Standalone mutation segments stay denied.
function reviewedQueryObjectPath(pathname,method){
 const segments=decodeURIComponent(pathname).split('/').filter(Boolean),tail=segments.at(-1)??'';
 const words=tail.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[._-]/g,' '),booleanStatus=method==='GET'&&/^(?:is|has|can)[A-Z]/.test(tail)&&!writeAction.test(words.replace(/\b(?:enable|disable)\b/gi,''));
 return (reads.test(tail)&&!writeAction.test(words)||booleanStatus)&&segments.slice(0,-1).every(s=>!writeAction.test(s));
}
export function websiteRequestAllowed(base, request, manualLogin=false, readEndpoints=[]) {
 let u; try {u=new URL(request.url);}catch{return false;}
 if(u.origin!==new URL(base).origin || !['GET','HEAD','POST','OPTIONS'].includes(request.method))return false;
 // Next.js data navigation carries the same reviewed route as the document,
 // behind a build/locale transport prefix. It is not a new API permission.
 // Require an explicit reviewed GET for the reconstructed route and reapply
 // its exact query/method rules; never grant arbitrary .json/static fetches.
 if(request.method==='GET'&&['xhr','fetch'].includes(request.resourceType)){
  const m=/^\/_next\/data\/[A-Za-z0-9_-]+\/([a-z]{2}(?:-[A-Za-z]{2})?)\/(.+)\.json$/.exec(u.pathname);
  if(m&&!/[\\%]/.test(m[2])&&!m[2].split('/').some(p=>p==='..'||p==='.'||!p)){
   const route=new URL(u);route.pathname='/'+m[2];
   if(readEndpoints.some(e=>e.reviewed===true&&e.method==='GET'&&reviewedPathMatches(e.path,route.pathname)))return websiteRequestAllowed(base,{...request,url:route.href},manualLogin,readEndpoints);
  }
 }
 // Static GET dependencies are not business mutation routes (e.g. reset.css).
 // Keep origin/method/type checks: a POST or XHR named delete.css is not exempt.
 if(request.method==='GET'&&(['stylesheet','script','font','image'].includes(request.resourceType)||['xhr','fetch'].includes(request.resourceType)&&/\.(?:css|less)$/i.test(u.pathname))&&/\.(?:css|less|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(u.pathname)&&![...u.searchParams].some(([k,v])=>writeAction.test(k)||/^(action|operation|command|cmd|method)$/i.test(k)&&writeAction.test(v)))return true;
 const reviewedEndpoint=readEndpoints.find(e=>e.reviewed===true&&e.method===request.method&&reviewedPathMatches(e.path,u.pathname));
 // Explicit reviewed method bindings take precedence over generic read-shaped fallbacks.
 if(!reviewedEndpoint&&!['HEAD','OPTIONS'].includes(request.method)&&readEndpoints.some(e=>e.reviewed===true&&reviewedPathMatches(e.path,u.pathname)))return false;
 const parts=decodeURIComponent(u.pathname).replace(/([a-z])([A-Z])/g,'$1 $2').split(/[\/._\s-]/).filter(Boolean);
 if(parts.some(x=>writeAction.test(x))&&!(reviewedEndpoint&&reviewedQueryObjectPath(u.pathname,request.method)))return false;
 for(const [key,value] of u.searchParams){
   const values=reviewedEndpoint?.queryParameters?.[key];
   const typed=reviewedEndpoint?.queryParameterTypes?.[key];if(typed&&!typedReadParameter(typed,value))return false;
   const fixedFilter=typedReadParameter(typed,value)||Object.hasOwn(reviewedEndpoint?.queryParameters??{},key)&&Array.isArray(values)&&values.includes(value);
   if(writeAction.test(key)&&!fixedFilter||/^(action|operation|command|cmd|method)$/i.test(key)&&writeAction.test(value))return false;
 }
 const tail=u.pathname.split('/').filter(Boolean).at(-1)??'index';
 if(manualLogin && /^(login|signin|sign-in|authenticate|auth|captcha|verify)(?:\.[a-z]+)?$/i.test(tail))return true;
 if(request.method==='POST') {
   // Known read-shaped routes only. A model cannot grant a new method or write route.
   const reviewed=readEndpoints.some(e=>e.reviewed===true&&e.method==='POST'&&reviewedPathMatches(e.path,u.pathname));
   if((!reads.test(tail)||/login|auth/i.test(tail))&&!reviewed)return false;
   if((request.body??'').length>16000)return false;
   if(reviewedEndpoint?.bodyParameters){
     if([...u.searchParams].some(([k,v])=>Object.hasOwn(reviewedEndpoint.bodyParameters,k)||!reviewedEndpoint.queryParameters?.[k]?.includes(v)))return false;
     let body;try{parseExactJson(request.body??'{}');body=JSON.parse(request.body??'{}');}catch{if(/^\s*[\[{]/.test(request.body??''))return false;try{const entries=[...new URLSearchParams(request.body??'')];if(new Set(entries.map(([k])=>k)).size!==entries.length)return false;body=Object.fromEntries(entries);}catch{return false;}}
     const expected=reviewedEndpoint.bodyParameters;
     if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==Object.keys(expected).length
       ||Object.entries(expected).some(([key,values])=>!Object.hasOwn(body,key)||!values.includes(body[key])))return false;
   }

   try { const values=JSON.stringify(JSON.parse(request.body??'{}')); if(/"(?:action|operation|command|cmd|method)"\s*:\s*"(?:save|delete|update|execute|trigger|start|stop)"/i.test(values))return false;}catch{if(/(?:^|&)(?:action|operation|cmd|method)=(?:save|delete|update|execute|trigger|start|stop)(?:&|$)/i.test(request.body??''))return false;}
   return true;
 }
 if(request.method==='OPTIONS')return true;
 return request.resourceType==='document'||/\.(?:js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|map)$/i.test(tail)||reads.test(tail)||u.pathname==='/' || readEndpoints.some(e=>e.reviewed===true&&e.method===request.method&&reviewedPathMatches(e.path,u.pathname)) || /\/(?:api\/)?(?:menus?|permissions?|profiles?|users?\/me)$/i.test(u.pathname);
}
// Explain a local policy rejection without treating it as a server response or
// account failure. No request body, query values or credential material leaves.
export function websiteRequestBoundary(base,request,manualLogin=false,readEndpoints=[]){
 let u;try{u=new URL(request.url);}catch{return {allowed:false,code:'INVALID_REQUEST_URL',requiresEndpointReview:false};}
 const allowed=websiteRequestAllowed(base,request,manualLogin,readEndpoints);
 if(allowed)return {allowed:true,code:null,requiresEndpointReview:false};
 if(u.origin!==new URL(base).origin)return {allowed:false,code:'REQUEST_ORIGIN_SCOPE',requiresEndpointReview:false};
 const reviewed=readEndpoints.filter(e=>e.reviewed===true&&reviewedPathMatches(e.path,u.pathname));
 if(reviewed.length&&!reviewed.some(e=>e.method===request.method)&&!['HEAD','OPTIONS'].includes(request.method))return {allowed:false,code:'REVIEWED_METHOD_MISMATCH',requiresEndpointReview:false};
 const candidate=request.method==='POST'&&!reviewed.length&&websiteRequestAllowed(base,request,manualLogin,[...readEndpoints,{method:'POST',path:u.pathname,reviewed:true}]);
 return {allowed:false,code:candidate?'READ_ENDPOINT_REVIEW_REQUIRED':'REQUEST_POLICY_DENIED',requiresEndpointReview:candidate,note:candidate?'请求尚未被本机只读规则认可，不代表账号失效或服务端拒绝。按真实源码核对用途后由维护者登记精确方法和路径；不能只凭命名认定只读，也不能通过改方法或重放写操作绕过。':'本机请求边界拒绝；不是服务端业务响应。'};
}
// Explicit operator-approved login UI preferences, distinct from read endpoints.
// Only an account authenticated by this browser session may use the exception.
export function websiteLoginPreferenceAllowed(e,request,principal){
 const p=e.loginPreferences;if(!p||principal?.credentialRef!==e.credentialRef||principal?.accountName!==p.accountName)return false;
 let u;try{u=new URL(request.url);}catch{return false;}
 return u.origin===new URL(e.baseUrl).origin&&!u.search&&request.method==='POST'&&!(request.body??'').trim()&&p.paths.includes(u.pathname);
}
export function validateLoginPreferences(e){
 const p=e.loginPreferences;if(p===undefined)return;
 if(e.kind!=='website'||!p||Object.keys(p).some(k=>!['accountName','paths','loginUrl'].includes(k))||typeof p.accountName!=='string'||!p.accountName.trim()||!Array.isArray(p.paths)||!p.paths.length||p.paths.some(x=>typeof x!=='string'||!/^\/[A-Za-z0-9_./-]+$/.test(x)||x.includes('..')))throw Error('登录界面偏好例外配置无效');
 websiteNavigationTarget(p.loginUrl,e.baseUrl);
}
export function cleanWebsiteText(value,limit=10000) {
 return String(value??'').replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'[凭据已隐藏]').replace(/((?:["']?)(?:password|passwd|pwd|secret|appSecret|apiKey|appKey|token|identitytoken|access.?token|refresh.?token|authorization|cookie|密码|令牌|密钥)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,'$1[已隐藏]').slice(0,limit);
}

export function validateWebsiteReadEndpoints(value){
 if(!Array.isArray(value)||value.length>512)throw new Error('网站只读接口配置必须为最多512项');
 for(const e of value){
  if(!e||Object.keys(e).some(k=>!['method','path','reviewed','queryParameters','queryParameterTypes','bodyParameters'].includes(k))||!['GET','POST'].includes(e.method)||e.reviewed!==true||typeof e.path!=='string'||!/^\/[A-Za-z0-9_./{}-]+$/.test(e.path)||e.path.includes('..')||e.path.includes('//'))throw new Error('网站只读接口必须为审核后的固定路径和GET/POST方法');
  const segments=e.path.split('/');if(segments.some(s=>/[{}]/.test(s)&&!Object.hasOwn(readPathIds,/^\{([A-Za-z]+)\}$/.exec(s)?.[1]??''))||e.method!=='GET'&&/[{}]/.test(e.path))throw new Error('动态只读路径仅允许GET和完整的objectId/uuid/integerId占位段');
  if(e.queryParameters!==undefined){
   const filters=e.queryParameters;
   if(!filters||typeof filters!=='object'||Array.isArray(filters)||Object.keys(filters).length>32)throw new Error('只读筛选参数必须为固定值映射');
   for(const [key,values]of Object.entries(filters))if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||/^(?:action|operation|command|cmd|method|__proto__|constructor|prototype)$/i.test(key)||/password|secret|token|credential/i.test(key)||!Array.isArray(values)||!values.length||values.length>32||values.some(v=>typeof v!=='string'||!v.length||v.length>100||/[\x00-\x1f\x7f]/.test(v)))throw new Error('只读筛选仅允许审核后的固定非敏感值；不能覆盖动作或执行参数');
  }
  if(e.queryParameterTypes!==undefined){const types=e.queryParameterTypes;if(e.method!=='GET'||!types||typeof types!=='object'||Array.isArray(types)||!Object.keys(types).length||Object.keys(types).length>32||Object.entries(types).some(([k,t])=>!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)||/^(?:action|operation|command|cmd|method|__proto__|constructor|prototype)$/i.test(k)||/password|secret|token|credential/i.test(k)||t!=='isoTimestamp'||Object.hasOwn(e.queryParameters??{},k)))throw Error('只读时间参数必须绑定审核GET及ISO UTC时间类型');}
  if(e.bodyParameters!==undefined){
   if(e.method!=='POST'||!e.bodyParameters||typeof e.bodyParameters!=='object'||Array.isArray(e.bodyParameters)||!Object.keys(e.bodyParameters).length)throw new Error('固定只读请求体仅适用于POST');
   // Reuse fixed non-secret value validation without accepting action/credential fields.
   validateWebsiteReadEndpoints([{method:'POST',path:e.path,reviewed:true,queryParameters:e.bodyParameters}]);
  }
  const parts=e.path.replace(/([a-z])([A-Z])/g,'$1 $2').split(/[\/._\s-]/).filter(Boolean);
  if(parts.some(p=>writeAction.test(p))&&!reviewedQueryObjectPath(e.path,e.method))throw new Error('网站只读接口不能包含修改操作');
 }
 return value;
}

// Exact public static dependencies reviewed from the application entry, not an
// origin-wide business API grant. Never include query strings, credentials or redirects.
export function validateWebsiteStaticResources(value,base){
 if(!Array.isArray(value)||value.some(url=>{try{const u=new URL(websiteUrl(url));return (u.protocol!=='https:'&&(!base||u.origin!==new URL(base).origin))||u.username||u.password||u.search||u.hash||/[*{}]/.test(decodeURIComponent(u.pathname))||u.href!==url||! /\.(js|css|json|woff2?|ttf|png|jpe?g|webp|gif|svg|ico)$/i.test(u.pathname);}catch{return true;}}))throw new Error('静态依赖须为审核后的精确资源URL（同源HTTP或HTTPS，跨源仅HTTPS），不能含凭据、查询参数、通配符或业务接口');
 return value;
}
export function validateWebsiteStaticRoots(value){
 if(!Array.isArray(value)||value.some(url=>{try{const u=new URL(websiteUrl(url));return u.protocol!=='https:'||u.search||u.hash||u.href.replace(/%7Bhex%7D/gi,'{hex}')!==url||!/^\/(?:[A-Za-z0-9_-]+\/|\{hex\}\/){2,}$/.test(decodeURIComponent(u.pathname));}catch{return true;}}))throw Error('公共静态目录须为审核后的HTTPS多段目录，仅可用整段{hex}表示8至64位哈希，不能含任意通配符、查询或业务接口');
 return value;
}
const imageRootParts=Object.freeze({date:/^\d{4}-\d{2}-\d{2}$/,compactDate:/^\d{8}$/});
const imageExtension=/\.(?:jpe?g|png|webp|gif|avif|bmp|ico)$/i;
export function validateWebsiteImageRoots(roots){
 if(!Array.isArray(roots)||roots.length>32||roots.some(root=>{
  try{
   const u=new URL(websiteUrl(root)),parts=decodeURIComponent(u.pathname).split('/').slice(1,-1);
   return u.protocol!=='https:'||u.href.replace(/%7B(date|compactDate)%7D/g,'{$1}')!==root||!u.pathname.endsWith('/')
    ||!parts.some(part=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(part))
    ||parts.some(part=>!/^(?:[A-Za-z0-9_-]+|\{date\}|\{compactDate\})$/.test(part));
  }catch{return true;}
 }))throw Error('图片来源须为固定HTTPS目录，仅支持整段日期占位符');
 return roots;
}

export function websiteImageResourceAllowed(request,roots=[]){
 if(request.method!=='GET'||request.resourceType!=='image'||!roots.length)return false;
 try{
  validateWebsiteImageRoots(roots);
  const u=new URL(request.url);
  if(u.username||u.password||u.search||u.hash||/%(?:2e|2f|5c|25)/i.test(u.pathname))return false;
  const parts=decodeURIComponent(u.pathname).split('/');
  if(parts.some(part=>part==='.'||part==='..'||/[\\%\x00-\x1f\x7f]/.test(part))||!imageExtension.test(parts.at(-1)))return false;
  return roots.some(root=>{
   const b=new URL(root),prefix=decodeURIComponent(b.pathname).split('/').slice(0,-1);
   return u.origin===b.origin&&parts.length===prefix.length+1&&prefix.every((part,index)=>{
    const pattern=part.startsWith('{')&&imageRootParts[part.slice(1,-1)];
    return pattern?pattern.test(parts[index]):part===parts[index];
   });
  });
 }catch{return false;}
}
export function validateWebsiteLoginReads(value){
 if(!Array.isArray(value)||value.some(e=>!e||Object.keys(e).some(k=>!['origin','path','types','method','reviewed','bodyParameters'].includes(k))||(()=>{try{const u=new URL(websiteUrl(e.origin));return u.protocol!=='https:'||u.origin!==e.origin;}catch{return true;}})()||(e.method!==undefined&&!['GET','POST'].includes(e.method))||e.method==='POST'&&(e.reviewed!==true||writeAction.test((e.path??'').replace(/[\/_-]/g,' '))||/register|grant|consent|revoke/i.test(e.path??'')||e.path?.endsWith('/'))||typeof e.path!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(e.path)||!Array.isArray(e.types)||!e.types.length||e.types.some(t=>!['document','image','script','xhr','fetch'].includes(t))))throw Error('认证读取仅允许审核后的HTTPS来源、明确路径与资源类型，POST仅允许人工审核的精确认证路径，不支持业务写入');
 for(const e of value)if(e.bodyParameters!==undefined){
  const b=e.bodyParameters;
  if(e.method!=='POST'||!b||typeof b!=='object'||Array.isArray(b)||!Object.keys(b).length||Object.keys(b).length>16||Object.entries(b).some(([k,values])=>! /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)||/password|secret|token|cookie|credential/i.test(k)||!Array.isArray(values)||!values.length||values.length>16||values.some(v=>typeof v!=='string'||!v.length||v.length>300||/[\x00-\x1f\x7f]/.test(v))))throw Error('认证确认必须绑定审核后的固定非秘密请求字段');
 }
 return value;
}
function loginRedirectAllowed(value,base,navigation,depth=0){
 if(depth>4)return false;try{const u=new URL(value,base);if(u.username||u.password)return false;if(u.origin===new URL(base).origin)return true;if(!loginPageAllowed(u.href,navigation))return false;if(/\/callback\/?$/.test(u.pathname))return true;const nested=[...u.searchParams].filter(([k])=>/^(?:redirect_?uri|redirect_?url|callback_?url|return_?url)$/i.test(k));return nested.length===1&&loginRedirectAllowed(nested[0][1],base,navigation,depth+1);}catch{return false;}
}
export function websiteLoginReadAllowed(request,waiting,reads=[],base,navigation){
 if(!waiting||!['GET','POST'].includes(request.method))return false;
 try{validateWebsiteLoginReads(reads);const u=new URL(request.url);if(u.username||u.password||/%|\\/.test(u.pathname))return false;for(const[key,value]of u.searchParams)if(/^(?:redirect_?uri|redirect_?url|callback_?url|return_?url)$/i.test(key)&&(!base||!loginRedirectAllowed(value,base,navigation)))return false;return reads.some(e=>{
   if((e.method??'GET')!==request.method||u.origin!==e.origin||!e.types.includes(request.resourceType))return false;
   const slashAlias=request.method==='GET'&&request.resourceType==='document'&&loginPageAllowed(u.href,navigation)&&u.pathname.replace(/\/$/,'')===e.path.replace(/\/$/,'');
   if(u.pathname!==e.path&&!slashAlias&&!(request.method==='GET'&&e.path.endsWith('/')&&u.pathname.startsWith(e.path)))return false;
   if(e.bodyParameters!==undefined){let body;try{body=parseExactJson(request.body);}catch{return false;}if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==Object.keys(e.bodyParameters).length||Object.entries(e.bodyParameters).some(([k,values])=>typeof body[k]!=='string'||!values.includes(body[k])))return false;}
   return true;
  });}catch{return false;}
}
export function websiteStaticResourceAllowed(base,request,resources=[],roots=[],{identityPage=false}={}){
 if(!Array.isArray(resources)||request.method!=='GET')return false;
 let rooted=false;try{validateWebsiteStaticRoots(roots);const u=new URL(request.url);const decoded=decodeURIComponent(u.pathname);const safe=!/%(?:2e|2f|5c|25)/i.test(u.pathname)&&!/[\\%\x00-\x1f]/.test(decoded)&&!decoded.split('/').includes('..');rooted=!u.search&&!u.hash&&safe&&roots.some(root=>{const b=new URL(root);if(b.origin!==u.origin)return false;const prefix=decodeURIComponent(b.pathname).split('/').filter(Boolean),parts=decoded.split('/').filter(Boolean);return parts.length>prefix.length&&prefix.every((segment,i)=>segment==='{hex}'?/^[a-f0-9]{8,64}$/i.test(parts[i]):parts[i]===segment);});}catch{return false;}
 if(!resources.includes(request.url)&&!rooted)return false;
 try{const u=new URL(request.url);validateWebsiteStaticResources([request.url],base);const types={script:/\.js$/i,other:/\.js$/i,stylesheet:/\.css$/i,font:/\.(?:woff2?|ttf)$/i,image:/\.(?:png|jpe?g|webp|gif|svg|ico)$/i,xhr:identityPage?/\.(?:json|js)$/i:/\.json$/i,fetch:/\.json$/i};return Boolean(types[request.resourceType]?.test(u.pathname));}catch{return false;}
}
