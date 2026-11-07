import {BrowserInputError,websitePageLocation} from './browser-tool-input.js';

// A missing record is not evidence that the registered application is wrong.
// The evidence must come from a new, authorized snapshot, never model-supplied URLs.
export function websiteFinding(args,snapshot){
 const fields=['kind','targetKind','expectedApplication','observedApplication','evidence','reason'];
 const fail=message=>{throw new BrowserInputError('WEBSITE_FINDING_INPUT',message);};
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!fields.includes(k))||fields.some(k=>typeof args[k]!=='string'||!args[k].trim()||args[k].length>2000))fail('提供kind、targetKind、expectedApplication、observedApplication、当前页面原文evidence及具体reason；未找到接口/记录不能直接判定网站不匹配。');
 if(!['other_application','target_not_found','navigation_blocked'].includes(args.kind)||!['application','interface','record'].includes(args.targetKind))fail('kind使用other_application/target_not_found/navigation_blocked；targetKind使用application/interface/record。');
 if(snapshot?.loginRequired||snapshot?.pageStatus==='loading')fail('页面仍需登录或加载，先恢复已有登录/等待页面，不能据此判定入口不匹配。');
 const text=String(snapshot?.pageText??'');
 if(!text.includes(args.evidence)||args.evidence.trim().length<4||!text.includes(args.observedApplication))fail('evidence与observedApplication必须出现在最新页面文本中；刷新快照并提供实际菜单/标题/页面证据，不猜测。');
 if(args.kind==='other_application'&&(args.targetKind!=='application'||args.expectedApplication.trim()===args.observedApplication.trim()||text.includes(args.expectedApplication)))fail('目标应用仍在当前页面，或缺少不同应用证据。共享管理平台内尚未定位接口/记录应使用target_not_found；导航被拦用navigation_blocked。');
 let location;try{location=websitePageLocation(snapshot.url);}catch{fail('当前快照缺少可核验的实际网址，不能提交入口判断。');}
 const finding={version:1,kind:args.kind,targetKind:args.targetKind,expectedApplication:args.expectedApplication,observedApplication:args.observedApplication,evidence:args.evidence,reason:args.reason,location,readAt:snapshot.readAt??null};
 return {websiteMismatch:args.kind==='other_application',websiteFinding:finding,partial:true,stage:args.kind==='other_application'?'已记录不同应用的页面证据；仅该页面不匹配，保留原授权与已有证据':args.kind==='target_not_found'?'已进入管理平台，但目标尚未定位；保留入口继续查应用目录、筛选和历史记录，不索取已有凭据':'页面导航或读取受阻；保留具体路径和证据，交由同问题修复，不等于账号失效'};
}
export function websiteFindingSummary(result){
 const f=result.websiteFinding;
 if(!f)return '旧记录仅报告入口不匹配，未保存具体页面判断证据；不能据此永久排除已登记入口或认定凭据失效，应先复核同一授权入口。';
 return `${result.stage}。\n实际页面：${f.location}\n目标应用：${f.expectedApplication}；看到：${f.observedApplication}\n页面证据：${f.evidence}\n具体原因：${f.reason}\n未取得的业务事实仍保留缺口；共享平台内查不到目标不等于网站错误，不改变系统/环境/身份或扩大权限。`;
}
