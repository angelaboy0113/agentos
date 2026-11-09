// Fixed diagnostic projection of an already-authorised control; no values, HTML,
// arbitrary expressions, selectors, console buffers or hidden application state.
export function inspectWebsiteControl(el){
 const chain=[];let current=el;
 for(let depth=0;current&&depth<7;depth++,current=current.parentElement){
  const css=getComputedStyle(current),rect=current.getBoundingClientRect();
  chain.push({tag:current.tagName.toLowerCase(),display:css.display,visibility:css.visibility,overflow:css.overflow,maxHeight:css.maxHeight,height:Math.round(rect.height),width:Math.round(rect.width),hidden:current.hidden===true,expanded:current.getAttribute('aria-expanded')});
 }
 const scope=el.closest('form,[role="search"],[role="group"],.el-form,.ant-form')??el.parentElement;
 const fields=scope?[...scope.querySelectorAll('input:not([type=hidden]):not([type=password]),select,textarea')].filter(x=>!x.closest('[data-sensitive],[data-agentos-secret]')&&!/password|secret|token|credential|密码|密钥/i.test([x.name,x.id,x.placeholder].join(' '))):[];
 return {chain,scopeFields:{total:fields.length,visible:fields.filter(x=>x.getClientRects().length&&getComputedStyle(x).visibility!=='hidden').length},note:'当前控件的布局与筛选字段可见数量；不读取隐藏字段值。诊断本身不点击、不发业务请求，不能单独证明部署版本或业务根因。'};
}
