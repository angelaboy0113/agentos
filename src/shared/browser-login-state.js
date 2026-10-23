// Fixed DOM probe: returns categories only, never account/password/token values or server text.
export function browserLoginState(){
 const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);
 const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(location.pathname+location.hash);
 const text=document.body?.innerText?.trim()??'';
 const challenge=[...document.querySelectorAll('input,img,canvas,[role=dialog]')].filter(visible).some(e=>/验证码|短信码|扫码|captcha|verification code|QR code/i.test([e.getAttribute('placeholder'),e.getAttribute('aria-label'),e.getAttribute('alt'),e.getAttribute('title')].filter(Boolean).join(' ')));
 const passwordChange=passwords.length>1&&/新密码|确认密码|new password|confirm password/i.test(text);
 const error=[...document.querySelectorAll('[role=alert],.el-message--error,.ant-message-error,.el-form-item__error')].filter(visible).some(e=>/错误|失败|不正确|无效|锁定|拒绝|必填|不能为空|error|fail|invalid|incorrect|locked|denied|required/i.test(e.innerText??''));
 const loading=!text||/^(?:加载中[.。…]*|正在加载[.。…]*|loading[.。…]*)$/i.test(text);
 const loginRequired=!!(passwords.length||authPath||passwordChange||challenge);
 const loginState=passwordChange?'password_change_required':challenge?'verification_required':loginRequired?(error?'rejected':'login_required'):loading?'loading':'ready';
 return {loginState,loginRequired,credentialFormVisible:passwords.length>0,verificationRequired:challenge,passwordChangeRequired:passwordChange,credentialRejected:loginState==='rejected',pageReady:loginState==='ready'};
}
// Examine allowlisted response fields transiently; raw payloads and text never leave this function.
export function authResponseState(status,payload){
 if(status===429)return {loginState:'rate_limited',rateLimited:true,code:'AUTH_RATE_LIMITED'};
 if(status>=500)return {loginState:'service_error',serviceUnavailable:true,code:'AUTH_SERVICE_UNAVAILABLE'};
 if(status>=400&&![401,403].includes(status))return {loginState:'request_error',requestFailed:true,code:'AUTH_REQUEST_FAILED'};
 if(status>=400)return {loginState:'rejected',credentialRejected:true,code:'AUTH_HTTP_REJECTED'};
 let rejected=false,verification=false,passwordChange=false;
 function inspect(v,depth=0){if(!v||typeof v!=='object'||depth>4)return;
  if(v.success===false||v.ok===false)rejected=true;
  for(const key of ['code','resCode','status','RETURN_CODE'])if(typeof v[key]==='string'&&/^(?:error|fail|invalid|unauthorized|forbidden|E[0-9])/i.test(v[key]))rejected=true;
  for(const key of ['message','msg','error','RETURN_DESC'])if(typeof v[key]==='string'){
   if(/密码.*(?:错误|不正确)|账号.*(?:锁定|不存在)|invalid credentials|incorrect password|account locked/i.test(v[key]))rejected=true;
   if(/验证码|短信验证|captcha|verification code/i.test(v[key]))verification=true;
   if(/修改密码|重置密码|change password|reset password/i.test(v[key]))passwordChange=true;
  }
  if(v.forceChangePassword===true||v.checkPasswordRule===true)passwordChange=true;
  for(const key of ['data','result','RESPONSE','RETURN_DATA','obj'])inspect(v[key],depth+1);
 }
 inspect(payload);
 return passwordChange?{loginState:'password_change_required',passwordChangeRequired:true}:verification?{loginState:'verification_required',verificationRequired:true}:rejected?{loginState:'rejected',credentialRejected:true,code:'AUTH_REJECTED'}:null;
}
