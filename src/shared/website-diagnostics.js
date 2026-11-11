// Observe the authorized page; never return console payloads, headers, bodies,
// query strings, storage or credentials. These are recent diagnostic metadata,
// not a replacement for a complete business/application log.
import{websitePageLocation}from'./browser-tool-input.js';
export function pageDiagnostic(s,{kind='runtime',name,message='',source,line,column,status,method,code}={}){
 const entry={kind,at:new Date().toISOString()};
 if(name&&/^[A-Za-z]+Error$/.test(name))entry.name=name;
 const property=String(message).match(/Cannot read propert(?:ies|y) of (?:undefined|null) \(reading ['"]([A-Za-z_$][\w$]*)['"]\)/);
 if(property&&!/password|secret|token|credential|authorization|key/i.test(property[1]))entry.undefinedProperty=property[1];
 if(source)try{const u=new URL(source),base=new URL(s.environment.baseUrl);if(u.origin===base.origin&&!u.username&&!u.password){entry.path=websitePageLocation(source).slice(u.origin.length);if(Number.isSafeInteger(line))entry.line=line;if(Number.isSafeInteger(column))entry.column=column;}}catch{}
 if(Number.isInteger(status))entry.status=status;
 if(['GET','HEAD','POST'].includes(method))entry.method=method;
 if((typeof code==='number'&&Number.isFinite(code))||(typeof code==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(code)))entry.code=code;
 s.readDiagnostics??=[];s.readDiagnostics.push(entry);if(s.readDiagnostics.length>64)s.readDiagnostics.shift();
}
export function websiteDiagnostics(s){return {url:websitePageLocation(s.page.url()),readOnly:true,scope:'current-authorized-task-page',recent:s.readDiagnostics??[],blockedRequests:s.blockedRequestDetails??[],blockedResources:[...s.blockedResources],resourceFailures:[...s.resourceFailures],pageErrorCategories:[...s.pageErrors],pendingReads:s.pendingReads.size,note:'仅当前页面最近的脱敏错误、资源和只读请求状态；无控制台原文、响应正文、认证头、存储或新请求。不是完整应用日志。'};}
