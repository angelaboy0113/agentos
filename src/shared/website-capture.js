// Fixed, local observations only: never return input values or accept caller-provided JS.
export function capturePageProbe({secretSelector}={}){
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 const loading=[...document.querySelectorAll('[aria-busy="true"],.el-loading-mask,.ant-spin-spinning,[role="progressbar"],.el-skeleton,.ant-skeleton-active')].some(visible);
 const body=document.body,fields=[...document.querySelectorAll('input,textarea,select')].filter(el=>visible(el)&&!el.matches(secretSelector??'input[type="password"]')).map(el=>el.value??'').join('\n'),text=(body?.innerText??'')+'\n'+fields;
 let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
 return {loading,blank:!(body?.innerText??'').trim(),documentReady:document.readyState==='complete',signature:[hash>>>0,body?.scrollHeight??0,document.querySelectorAll('tr,input,select,[role="dialog"]').length].join(':')};
}
// Mask credentials and explicitly marked secrets, not every readonly business field.
const attributes=['name','id','placeholder','aria-label'];
const secretNames=['password','passwd','pwd','secret','token','authorization','api_key','apikey','api-key','credential','密码','口令','令牌','密钥'];
export const screenshotSecretSelector=['input[type="password"]','[autocomplete*="password" i]','[autocomplete="one-time-code"]','[data-sensitive]','[data-agentos-secret]',...attributes.flatMap(attribute=>secretNames.map(name=>`:is(input,textarea,[contenteditable="true"])[${attribute}*="${name}" i]`))].join(',');
export async function waitForCaptureReady(state,{timeoutMs=12000,quietMs=600,sampleMs=100}={}){
 const began=Date.now();let stableAt=began,lastSignature=null,last;
 while(true){
  last=await state.page.evaluate(capturePageProbe,{secretSelector:screenshotSecretSelector});const now=Date.now();
  if(last.signature!==lastSignature){stableAt=now;lastSignature=last.signature;}
  const pending=state.pendingReads?.size??0,quietAt=Math.max(stableAt,state.lastReadActivity??began);
  if(last.documentReady&&!last.loading&&!last.blank&&!pending&&now-quietAt>=quietMs)return {status:'ready',waitedMs:now-began,pendingRequests:0,loadingIndicator:false};
  if(now-began>=timeoutMs)return {status:last.blank?'blank_timeout':'loading_timeout',waitedMs:now-began,pendingRequests:pending,loadingIndicator:last.loading};
  await state.page.waitForTimeout(Math.min(sampleMs,Math.max(1,timeoutMs-(now-began))));
 }
}
