// Fixed tool arguments are checked before touching the page. Never accept model JS or selectors.
export class BrowserInputError extends Error {
 constructor(code,message){super(message);this.name='BrowserInputError';this.code=code;this.statusCode=400;}
}
export const correctableBrowserCodes=new Set(['BROWSER_ARGUMENTS','BROWSER_REF_STALE','BROWSER_CONTROL_TYPE','BROWSER_CONTROL_CHANGED','BROWSER_OPERATION_TIMEOUT','BROWSER_CONTENT_CHANGED','BROWSER_ASSET_RESPONSE']);
export function validateBrowserTool(tool,args={}){
 if(tool==='browser_navigate'){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||typeof args.url!=='string'||!args.url.trim())throw new BrowserInputError('BROWSER_ARGUMENTS','browser_navigate仅接受同一已授权应用中、由页面或源码发现的只读url；不能传JS、选择器或凭据');return;
 }
 if(tool==='browser_assets'){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['ref','offset','limit','find','contentHash'].includes(k))||args.ref!==undefined&&(typeof args.ref!=='string'||!args.ref||args.ref.length>160)||args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1)||args.find!==undefined&&(typeof args.find!=='string'||!args.find||args.find.length>200)||args.contentHash!==undefined&&!/^[a-f0-9]{64}$/.test(args.contentHash)||!args.ref&&Object.keys(args).length)throw new BrowserInputError('BROWSER_ARGUMENTS','browser_assets仅接受本任务脚本ref及可选offset/limit/find/contentHash；空对象读取目录，不能传URL/JS/路径');return;
 }
 if(tool==='browser_read'){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['section','offset','limit','contentHash','find'].includes(k))||!['page','fields'].includes(args.section)||!Number.isSafeInteger(args.offset)||args.offset<0||!Number.isSafeInteger(args.limit)||args.limit<1||args.contentHash!==undefined&&!/^[a-f0-9]{64}$/.test(args.contentHash)||args.find!==undefined&&(typeof args.find!=='string'||!args.find||args.find.length>200))throw new BrowserInputError('BROWSER_ARGUMENTS','browser_read仅接受当前可见page/fields、非负offset、正整数limit和可选前页contentHash；不能传URL、JS或选择器');return;
 }

 const fields={connection:[],browser_diagnostics:[],browser_hover:['ref'],browser_context_menu:['ref'],browser_frames:[],browser_frame:['ref'],browser_recover:[],browser_open:[],browser_snapshot:[],browser_screenshot:[],browser_inspect:['ref'],browser_click:['ref'],browser_select:['ref','value'],browser_search:['ref','text'],browser_key:['ref','key'],browser_scroll:['ref','direction']};
 const required=fields[tool];
 if(!required||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!required.includes(k))||required.some(k=>typeof args[k]!=='string'||args[k].length>(k==='ref'?160:200)||(k==='ref'&&!args[k])))throw new BrowserInputError('BROWSER_ARGUMENTS','网页工具参数不完整或格式不符；按工具目录提供全部字段，使用当前snapshot返回的引用。搜索须提供text，选择须提供value。');
 if(tool==='browser_key'&&(!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','PageDown','PageUp','Space'].includes(args.key)||args.ref==='page'&&args.key!=='Escape')||tool==='browser_scroll'&&!['up','down','left','right'].includes(args.direction))throw new BrowserInputError('BROWSER_ARGUMENTS','只允许当前控件的页面交互按键和上下左右滚动；page引用仅允许Escape关闭弹层，不能调用浏览器/系统快捷键。');
}
export function websitePageLocation(value){const u=new URL(value),path=u.pathname.replace(/(\/(?:login\/state|(?:connect\/)?qrcode)\/)\S+/ig,'$1[opaque]');return u.origin+path+(/^[#]\//.test(u.hash)?u.hash.split('?')[0]:'');}

// A redacted URL is not evidence that its query was absent. Names only, never
// values; distinguish history routes from #/ routes without guessing either.
export function websitePageRoute(value){
 const u=new URL(value),hashRoute=u.hash.startsWith('#/'),route=hashRoute?new URL(u.hash.slice(1),u.origin):null;
 const keys=params=>[...new Set([...params.keys()].filter(k=>/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)&&!/password|passwd|pwd|secret|token|authorization|cookie|credential|api.?key/i.test(k)))].sort();
 return {mode:hashRoute?'hash':'history',queryKeys:keys(u.searchParams),hashQueryKeys:route?keys(route.searchParams):[],queryValuesRedacted:true,note:'仅显示参数名称；url字段已脱敏，不能据此认定参数丢失。'};
}

export const screenshotRequested=job=>{const text=String(job.originalQuestion??job.instruction??'');return /截图|screenshot/i.test(text)&&!/(?:不要|无需|不需要|禁止|不能|不允许|不必).{0,8}截图|(?:no|without|don.t).{0,12}screenshots?/i.test(text);};
