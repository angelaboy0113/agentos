import { createHash } from 'node:crypto';
export const writeAction = /新增|创建|保存|修改|编辑|删除|启动|停止|执行一次|立即执行|触发|重跑|终止|发布|启用|禁用|提交|审批|支付|注销|退出|\b(add|create|save|update|edit|delete|remove|start|stop|trigger|execute|run|restart|reset|kill|publish|enable|disable|submit|approve|pay|logout)\b/i;
const reads = /^(?:get|list|page|pageList|query|search|find|detail|view|info|index|home|dashboard|status|log|logs|logDetailCat|logDetailPage|toLogin|login|auth|check|count|select|load|read)[a-z0-9_-]*$/i;
export function websiteUrl(input) {
 const u = new URL(input);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||(u.hostname==='localhost'||u.hostname.endsWith('.localhost'))||/^(127\.|0\.|169\.254\.|\[?::1\]?)/.test(u.hostname)) throw new Error('网页入口必须是不含凭据的业务HTTP(S)地址，不能是本机管理或链路本地地址');
 u.hash=''; return u.toString();
}
export const websiteSessionKey = (project,tier,url) => 'web-'+createHash('sha256').update(JSON.stringify([project,tier,new URL(websiteUrl(url)).origin])).digest('hex').slice(0,24);
// Registration identifies the requested application entry; session storage remains origin-scoped.
export const websiteKey = (project,tier,url) => 'web-entry-'+createHash('sha256').update(JSON.stringify([project,tier,websiteUrl(url)])).digest('hex').slice(0,24);
export function websiteRequestAllowed(base, request, manualLogin=false, readEndpoints=[]) {
 let u; try {u=new URL(request.url);}catch{return false;}
 if(u.origin!==new URL(base).origin || !['GET','HEAD','POST','OPTIONS'].includes(request.method))return false;
 const parts=decodeURIComponent(u.pathname).replace(/([a-z])([A-Z])/g,'$1 $2').split(/[\/._\s-]/).filter(Boolean);
 if(parts.some(x=>writeAction.test(x)))return false;
 for(const [key,value] of u.searchParams) if(writeAction.test(key)||/^(action|operation|command|cmd|method)$/i.test(key)&&writeAction.test(value)) return false;
 const tail=u.pathname.split('/').filter(Boolean).at(-1)??'index';
 if(manualLogin && /^(login|signin|sign-in|authenticate|auth|captcha|verify)(?:\.[a-z]+)?$/i.test(tail))return true;
 if(request.method==='POST') {
   // Known read-shaped routes only. A model cannot grant a new method or write route.
   const reviewed=readEndpoints.some(e=>e.reviewed===true&&e.method==='POST'&&e.path===u.pathname);
   if((!reads.test(tail)||/login|auth/i.test(tail))&&!reviewed)return false;
   if((request.body??'').length>16000)return false;
   try { const values=JSON.stringify(JSON.parse(request.body??'{}')); if(/"(?:action|operation|command|cmd|method)"\s*:\s*"(?:save|delete|update|execute|trigger|start|stop)"/i.test(values))return false;}catch{if(/(?:^|&)(?:action|operation|cmd|method)=(?:save|delete|update|execute|trigger|start|stop)(?:&|$)/i.test(request.body??''))return false;}
   return true;
 }
 if(request.method==='OPTIONS')return true;
 return request.resourceType==='document'||/\.(?:js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|map)$/i.test(tail)||reads.test(tail)||u.pathname==='/' || readEndpoints.some(e=>e.reviewed===true&&e.method===request.method&&e.path===u.pathname) || /\/(?:api\/)?(?:menus?|permissions?|profiles?|users?\/me)$/i.test(u.pathname);
}
export function cleanWebsiteText(value) {
 return String(value??'').replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'[凭据已隐藏]').replace(/((?:password|passwd|secret|access.?token|refresh.?token|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').slice(0,10000);
}

export function validateWebsiteReadEndpoints(value){
 if(!Array.isArray(value)||value.length>32)throw new Error('网站只读接口配置必须为最多32项');
 for(const e of value){
  if(!e||Object.keys(e).some(k=>!['method','path','reviewed'].includes(k))||!['GET','POST'].includes(e.method)||e.reviewed!==true||typeof e.path!=='string'||!/^\/[A-Za-z0-9_./-]+$/.test(e.path)||e.path.includes('..')||e.path.includes('//'))throw new Error('网站只读接口必须为审核后的固定路径和GET/POST方法');
  const parts=e.path.replace(/([a-z])([A-Z])/g,'$1 $2').split(/[\/._\s-]/).filter(Boolean);
  if(parts.some(p=>writeAction.test(p)))throw new Error('网站只读接口不能包含修改操作');
 }
 return value;
}
