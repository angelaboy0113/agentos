// Observe the authorized page; never return console payloads, headers, bodies,
// query strings, storage or credentials. These are recent diagnostic metadata,
// not a replacement for a complete business/application log.
import{websitePageLocation,websitePageRoute}from'./browser-tool-input.js';
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
export function pendingWebsiteReads(s,now=Date.now()){
 const reads=[];
 for(const request of s.pendingReads??[]){
  const meta=s.pendingReadMetadata?.get(request);if(!meta)continue;
  try{const u=new URL(request.url()),base=new URL(s.environment.baseUrl);
   if(u.origin!==base.origin||u.username||u.password)continue;
   reads.push({method:['GET','HEAD','POST'].includes(request.method())?request.method():'OTHER',path:websitePageLocation(u.href).slice(u.origin.length),startedAt:new Date(meta.startedAt).toISOString(),elapsedMs:Math.max(0,now-meta.startedAt),queryInitiated:meta.queryInitiated===true});
  }catch{}
 }
 return {pendingReads:s.pendingReads?.size??0,pendingQueries:reads.filter(x=>x.queryInitiated).length,pendingReadDetails:reads.slice(-20)};
}
export function websiteDiagnostics(s){return {url:websitePageLocation(s.page.url()),route:websitePageRoute(s.page.url()),readOnly:true,scope:'current-authorized-task-page',recent:s.readDiagnostics??[],blockedRequests:s.blockedRequestDetails??[],blockedResources:[...s.blockedResources],resourceFailures:[...s.resourceFailures],pageErrorCategories:[...s.pageErrors],...pendingWebsiteReads(s),note:'仅当前页面最近的脱敏错误、资源和只读请求状态；无控制台原文、响应正文、认证头、存储或新请求。不是完整应用日志。'};}

export function websiteActionDiagnostics(s,action){
 if(!action)return null;
 const since=Date.parse(action.startedAt),until=action.endedAt?Date.parse(action.endedAt):Infinity,inWindow=x=>Date.parse(x.at)>=since&&Date.parse(x.at)<=until,recent=(s.readDiagnostics??[]).filter(inWindow);
 return {...action,requestsObservedDuringAction:recent.filter(x=>x.kind==='request'),blockedDuringAction:(s.blockedRequestDetails??[]).filter(inWindow),recent:recent.filter(x=>x.kind!=='request'),note:'仅本次动作期间的观察，不代表因果关联；页面blockedRequests是历史累计。无新请求不等于无业务数据，先核对页面校验与本次脚本诊断。'};
}
