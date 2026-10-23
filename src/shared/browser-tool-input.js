// Fixed tool arguments are checked before touching the page. Never accept model JS or selectors.
export class BrowserInputError extends Error {
 constructor(code,message){super(message);this.name='BrowserInputError';this.code=code;this.statusCode=400;}
}
export const correctableBrowserCodes=new Set(['BROWSER_ARGUMENTS','BROWSER_REF_STALE','BROWSER_CONTROL_TYPE','BROWSER_CONTROL_CHANGED','BROWSER_OPERATION_TIMEOUT']);
export function validateBrowserTool(tool,args={}){
 const fields={connection:[],browser_open:[],browser_snapshot:[],browser_screenshot:[],browser_click:['ref'],browser_select:['ref','value'],browser_search:['ref','text']};
 const required=fields[tool];
 if(!required||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!required.includes(k))||required.some(k=>typeof args[k]!=='string'||args[k].length>(k==='ref'?160:200)||(k==='ref'&&!args[k])))throw new BrowserInputError('BROWSER_ARGUMENTS','网页工具参数不完整或格式不符；按工具目录提供全部字段，使用当前snapshot返回的引用。搜索须提供text，选择须提供value。');
}
export function websitePageLocation(value){const u=new URL(value);return u.origin+u.pathname+(/^[#]\//.test(u.hash)?u.hash.split('?')[0]:'');}

export const screenshotRequested=job=>{const text=String(job.originalQuestion??job.instruction??'');return /截图|screenshot/i.test(text)&&!/(?:不要|无需|不需要|禁止|不能|不允许|不必).{0,8}截图|(?:no|without|don.t).{0,12}screenshots?/i.test(text);};
