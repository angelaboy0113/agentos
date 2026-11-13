import {cleanWebsiteText} from '../shared/website-policy.js';
const failure=(code,message)=>Object.assign(new Error(message),{code});
// Raw response bodies, headers, cookies and arbitrary nested fields never leave
// this projection. Preserve diagnostic text/stack traces, redact credential forms.
export function redactTsfLog(value,secrets=[]){
 let text=String(value);
 for(const secret of secrets.filter(x=>typeof x==='string'&&x))text=text.split(secret).join('[redacted]');
 text=text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[JWT redacted]')
  .replace(/((?:["']?)(?:x[-_]api[-_]key|client[-_]secret|aws_secret_access_key|session[_-]?id|skey|csrf(?:code)?)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,'$1[redacted]')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[private key redacted]')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]+/gi,'$1 [redacted]')
  .replace(/((?:https?|mongodb(?:\+srv)?|mysql):\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
  .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi,'$1[redacted]')
  .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|secret|signature|credential|api[_-]?key)=)[^&#\s"']*/gi,'$1[redacted]');
 return cleanWebsiteText(text,Number.MAX_SAFE_INTEGER).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
}
export function createTsfLogTools({q,cred,cloud,app,group,page,paged,date,evidence}){
 const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:evidence().timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const localTime=n=>{const p=Object.fromEntries(formatter.formatToParts(new Date(n)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;};
 const spec=q.logApplications?.length?[
  {tool:'log_configurations',args:{applicationId:'configured log-enabled application ID',groupId:'configured exact deployment group ID'},description:'Read business-log collection configurations attached to this authorized live deployment group. Shared collection IDs do not grant other groups. No collection/config changes.'},
  {tool:'search_logs',args:{applicationId:'configured log-enabled application ID',groupId:'configured exact group ID',source:'stdout or business',configId:'business source only: exact ID from log_configurations',startTime:'explicit platform-local YYYY-MM-DD HH:mm:ss',endTime:'explicit platform-local YYYY-MM-DD HH:mm:ss',searchWords:['literal trace ID, exception class, request path or business reference; [] for the explicit time window'],offset:'0 or nextOffset',limit:'configured page size'},description:'Search existing TSF application logs read-only. source stdout searches standard output; business searches an actually attached log configuration. Group scope and namespace checked before/after; NORMAL literal search, explicit time range, paginated rows and credential-redacted content/stack traces. Empty results do not prove no exception or request. Use known request/trace/business IDs; do not replay the failing business request. TotalCount describes current search, not an immutable snapshot.'}
 ]:[];
 if(q.containerLogApplications?.length)spec.push({tool:'container_log_tail',args:{applicationId:'configured container-log-enabled application ID',groupId:'configured exact group ID',tailLines:'positive integer lines per container, e.g. 200; platform may return fewer'},description:'Read the existing current container stdout tail through the reviewed private TSF console read action. Not an archived history search: no historical completeness claim, returned lines may span different times. Log timestamps can be unknown. Credential-redacted content; multiple replicas may each contribute tailLines. Does not start streaming, restart or replay business requests.'});
 async function scope(args){if(!q.logApplications?.includes(args.applicationId))throw failure('TSF_SCOPE','Application log read not registered for this project/environment');const a=app(args.applicationId);return{a,g:await group(a,args.groupId)};}
 async function configurations(g){const v=await cloud.read('DescribeGroupBusinessLogConfigs',{GroupId:g.GroupId});if(!Array.isArray(v.Content)||!(typeof v.TotalCount==='number'&&Number.isSafeInteger(v.TotalCount)||typeof v.TotalCount==='string'&&/^\d+$/.test(v.TotalCount)&&Number.isSafeInteger(Number(v.TotalCount)))||Number(v.TotalCount)!==v.Content.length)throw failure('TSF_PAGINATION','Incomplete group log configuration list; no partial list treated as complete');const ids=new Set();return v.Content.map(x=>{if(typeof x.ConfigId!=='string'||!/^apm-busi-log-cfg-[A-Za-z0-9]+$/.test(x.ConfigId))throw failure('TSF_RESPONSE','Invalid group log configuration identifier');if(ids.has(x.ConfigId))throw failure('TSF_RESPONSE','Duplicate group log configuration identifier');ids.add(x.ConfigId);return{configId:x.ConfigId,name:redactTsfLog(x.ConfigName??'',[cred.password]),path:redactTsfLog(x.ConfigPath??'',[cred.password])};});}
 return{spec,async run(tool,args){
  if(tool==='search_logs'){
   // Check all caller input before authenticating or fetching platform records.
   date(args.startTime);date(args.endTime);if(args.startTime>args.endTime||!['stdout','business'].includes(args.source)||!Array.isArray(args.searchWords)||args.searchWords.some(x=>typeof x!=='string'||!x.trim()||/[\x00-\x1f\x7f]/.test(x))||args.source==='stdout'&&args.configId!==undefined||args.source==='business'&&(typeof args.configId!=='string'||!/^apm-busi-log-cfg-[A-Za-z0-9]+$/.test(args.configId)))throw failure('REPORT_INPUT','Log search requires explicit valid time range, source, literal searchWords array and business-only configId');page(args);
  }
  if(tool==='container_log_tail'&&(!q.containerLogApplications?.includes(args.applicationId)||!Number.isSafeInteger(args.tailLines)||args.tailLines<1))throw failure('REPORT_INPUT','Container logs require an explicitly enabled application and positive tailLines');
  const {a,g}=await scope(args);
  if(tool==='container_log_tail'){
   const raw=await cloud.read('SearchContainerStdoutLog',{GroupId:g.GroupId,TailLines:args.tailLines});
   if(!Array.isArray(raw.BusinessLogSet))throw failure('TSF_RESPONSE','Container tail response missing; not an empty archive');
   const rows=raw.BusinessLogSet.map(x=>{if(x.GroupId!==undefined&&x.GroupId!==g.GroupId)throw failure('TSF_SCOPE','Container tail contains another group; content withheld');if(typeof x.Content!=='string')throw failure('TSF_RESPONSE','Container log row lacks text');const timestamp=['number','string'].includes(typeof x.Timestamp)&&String(x.Timestamp).trim()&&Number.isSafeInteger(Number(x.Timestamp))&&Number(x.Timestamp)>0?x.Timestamp:null;return{...(typeof x.InstanceId==='string'?{instanceId:x.InstanceId}:{}),groupId:g.GroupId,timestamp,timeKnown:timestamp!==null,content:redactTsfLog(x.Content,[cred.password])};});
   await group(a,g.GroupId);return{applicationId:a.applicationId,applicationName:a.applicationName,groupId:g.GroupId,namespaceId:g.NamespaceId,source:'container-current-tail',requestedLinesPerContainer:args.tailLines,returnedLines:rows.length,rows,complete:false,historicalCoverageVerified:false,contentRedacted:true,scopeVerifiedBy:'fixed-group-request-and-live-namespace',note:'Current container tail only; rows can be fewer than requested, span different times or omit timestamps. Empty tail does not prove no error. Never treat this as complete historical logs.',...evidence()};
  }
  if(tool==='log_configurations'){const rows=await configurations(g);await group(a,g.GroupId);return{applicationId:a.applicationId,groupId:g.GroupId,namespaceId:g.NamespaceId,rows,complete:true,...evidence()};}
  if(args.source==='business'&&!(await configurations(g)).some(x=>x.configId===args.configId))throw failure('TSF_SCOPE','Log configuration not attached to this deployment group');
  const p=page(args),request={...p,StartTime:args.startTime,EndTime:args.endTime,SearchWords:args.searchWords,SearchWordType:'NORMAL',OrderBy:'time',OrderType:'asc',BatchType:'PAGE',...(args.source==='business'?{ConfigId:args.configId,GroupIds:[g.GroupId]}:{GroupId:g.GroupId})};
  const raw=await cloud.read(args.source==='business'?'SearchBusinessLog':'SearchStdoutLog',request);
  if(raw.Status!==undefined&&!['SUCCESS','normal'].includes(raw.Status))throw failure(['ERROR_RANGE_EXCEED','ERROR_COMPLEX_CONDITION'].includes(raw.Status)?'TSF_LOG_QUERY':'TSF_LOG_STATUS','Log query did not complete; status '+(/^[A-Z_a-z0-9]+$/.test(raw.Status)?raw.Status:'unrecognized')+'; no empty-result inference');
  const v=paged(raw,p),rows=v.rows.map(x=>{
   if(x.GroupId!==undefined&&x.GroupId!==g.GroupId)throw failure('TSF_SCOPE','Log response contains another deployment group; content withheld');
   if(typeof x.Content!=='string'||!['string','number'].includes(typeof x.Timestamp)||!Number.isSafeInteger(Number(x.Timestamp))||Number(x.Timestamp)<0||typeof x.Timestamp==='string'&&!/^\d+$/.test(x.Timestamp))throw failure('TSF_RESPONSE','Log row lacks content or an exact timestamp');
   const observed=localTime(Number(x.Timestamp));if(observed<args.startTime||observed>args.endTime)throw failure('TSF_LOG_RANGE','Platform returned log timestamp outside requested local-time range; no mixed-period evidence returned');
   return{...(typeof x.LogId==='string'?{logId:x.LogId}:{}),...(typeof x.InstanceId==='string'?{instanceId:x.InstanceId}:{}),timestamp:x.Timestamp,content:redactTsfLog(x.Content,[cred.password]),groupId:g.GroupId};
  });
  await group(a,g.GroupId);
  return{applicationId:a.applicationId,applicationName:a.applicationName,groupId:g.GroupId,namespaceId:g.NamespaceId,source:args.source,...(args.source==='business'?{configId:args.configId}:{}),rows,sourceTotal:v.sourceTotal,nextOffset:v.nextOffset,complete:v.complete,range:{startTime:args.startTime,endTime:args.endTime},platformStatus:raw.Status??null,scopeVerifiedBy:'fixed-group-request-and-live-namespace',snapshot:'Mutable log index; each page is a separate observation',emptyMeaning:rows.length?'Not applicable':'No indexed matches in this source/window; does not prove request absent, collection healthy or issue resolved',contentRedacted:true,...evidence()};
 }};
}
