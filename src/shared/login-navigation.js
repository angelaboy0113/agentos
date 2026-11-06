import {websiteNavigationTarget} from './website-policy.js';
// Trusted deployment configuration only. Never supplied by the planner.
export function validateLoginNavigation(value){
 if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['usernameLabel','steps','entryUrl'].includes(k))||typeof value.usernameLabel!=='string'||!value.usernameLabel.trim()||!Array.isArray(value.steps)||!value.steps.length||value.steps.some(s=>typeof s!=='string'||!s.trim()||/保存|删除|创建|提交|审批|授权|重置|修改|\b(?:save|delete|create|approve|reset|update)\b/i.test(s)))throw Error('登录导航只能配置已审核的账号字段标签和精确登录入口按钮名称');if(value.entryUrl!==undefined)websiteNavigationTarget(value.entryUrl);return value;
}
// Fixed page program: no selectors, arbitrary script, credential values or links.
export function loginNavigationPage({baseUrl,usernameLabel,step,entryUrl}){
 const base=new URL(baseUrl),u=new URL(location.href),prefix=base.pathname.replace(/\/$/,'');if(u.origin!==base.origin||!(u.pathname===prefix||u.pathname.startsWith(prefix+'/')))return{error:'登录导航已离开批准应用范围'};
 const visible=e=>!!e?.getClientRects().length&&!e.disabled&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 const field=[...document.querySelectorAll('input:not([type=password]):not([type=hidden])')].filter(visible).some(e=>[e.getAttribute('aria-label'),e.placeholder,...[...(e.labels??[])].map(l=>l.innerText)].some(v=>v?.trim()===usernameLabel));if(field)return{ready:true};if(!step)return{ready:false};
 if(entryUrl){const target=new URL(entryUrl);if(target.origin!==base.origin||target.pathname!==u.pathname)return{error:'登录入口导航必须留在已批准的同一页面'};history.replaceState(null,'',target.href);}
 const buttons=[...document.querySelectorAll('button,[role=button]')].filter(e=>visible(e)&&(e.innerText||e.getAttribute('aria-label')||'').trim()===step);if(buttons.length!==1)return{error:'已审核登录入口不存在或不唯一'};const b=buttons[0];if(b.getAttribute('aria-pressed')!=='true'&&b.getAttribute('aria-selected')!=='true')b.click();return{ready:false,navigated:true};
}
