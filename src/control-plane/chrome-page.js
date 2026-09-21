// Executed as a fixed program in the approved page. No model-provided JavaScript.
export function chromePage(request) {
 const {baseUrl,token,tool,args={}}=request;
 const base=new URL(baseUrl), current=new URL(location.href);
 const prefix=base.pathname.replace(/\/$/,'');
 const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash);
 if(current.origin===base.origin&&authPath)return {loginRequired:true,stage:'等待日常Chrome页面登录',message:`需要登录 ${base.href}；可在本机登录，或直接回复原任务卡“账号 / 密码”，登录后自动继续。`};
 if(current.origin!==base.origin || !(current.pathname===prefix||current.pathname.startsWith(prefix+'/')))
  return {error:'浏览器已离开本次批准的应用范围，请重新确认页面'};
 const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 const write=/新增|创建|保存|修改|编辑|删除|启动|停止|执行|触发|重跑|终止|发布|启用|禁用|提交|审批|支付|注销|退出|\b(add|create|save|update|edit|delete|remove|start|stop|trigger|execute|run|restart|reset|kill|publish|enable|disable|submit|approve|pay|logout)\b/i;
 const read=/查看|详情|日志|查询|搜索|下一页|上一页|刷新|展开|收起|search|query|view|detail|log|next|previous|refresh/i;
 const label=el=>(el.innerText||el.getAttribute('placeholder')||el.getAttribute('aria-label')||el.getAttribute('name')||el.id||'').trim().slice(0,100);
 function type(el){
  if(!visible(el)||el.disabled||el.closest('[contenteditable="true"]'))return null;
  const text=label(el),tag=el.tagName.toLowerCase();if(!text||write.test(text))return null;
  if(el.closest('[role=menu]')&&(el.matches('[role=menuitem]')||el.classList.contains('ant-menu-submenu-title')))return 'read-action';
  if(tag==='input')return /^(text|search|date|datetime-local|number)$/.test(el.type)&&/搜索|查询|日期|时间|名称|编号|search|filter|date|name|id/i.test(text)?'search':null;
  if(tag==='select')return 'select';
  if(tag==='a'){
   const raw=el.getAttribute('href');if(!raw||raw.startsWith('javascript:'))return null;
   const u=new URL(raw,location.href);
   if(u.origin!==base.origin||!(u.pathname===prefix||u.pathname.startsWith(prefix+'/'))||write.test(decodeURIComponent(u.pathname+u.search+u.hash)))return null;
   return 'read-action';
  }
  return read.test(text)?'read-action':null;
 }
 const key='__agentos_read_'+token;
 const state=window[key];
 if(!['connection','browser_open','browser_snapshot'].includes(tool)){
  const ref=state?.refs?.[args.ref];
  if(!ref||state.url!==location.href||!ref.el.isConnected||type(ref.el)!==ref.type||label(ref.el)!==ref.label||ref.el.getAttribute('href')!==ref.href)return {error:'页面引用已变化，请重新获取页面'};
  const el=ref.el;
  if(tool==='browser_click'&&ref.type==='read-action')el.click();
  else if(tool==='browser_search'&&ref.type==='search'&&typeof args.text==='string'&&args.text.length<=200){
   const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,args.text);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
  }else if(tool==='browser_select'&&ref.type==='select'&&typeof args.value==='string'&&args.value.length<=200&&[...el.options].some(o=>o.value===args.value)){
   el.value=args.value;el.dispatchEvent(new Event('change',{bubbles:true}));
  }else return {error:'本次只开放查询、查看与分页操作'};
  state.refs={};return {acted:true};
 }
 const login=[...document.querySelectorAll('input[type=password]')].some(visible);
 if(login)return {loginRequired:true,stage:'等待日常Chrome页面登录',message:`需要登录 ${base.href}；可在此Chrome页面完成，或直接回复原任务卡“账号 / 密码”，登录后自动继续。`};
 const refs={},controls=[],generation=(state?.generation??0)+1;let n=0;
 for(const el of [...document.querySelectorAll('a,button,select,[role=button],input,[role=menuitem],.ant-menu-submenu-title')].slice(0,500)){
  const t=type(el);if(!t)continue;const ref=token+'-'+generation+'-'+n++;
  const text=label(el);refs[ref]={el,type:t,label:text,href:el.getAttribute('href')};
  controls.push({ref,type:t,label:text,...(t==='select'?{options:[...el.options].slice(0,100).map(o=>({value:o.value,label:o.textContent}))}:{})});
  if(controls.length>=150)break;
 }
 Object.defineProperty(window,key,{value:{url:location.href,refs,generation},configurable:true});
 // Read only rendered text nodes, never input values, hidden templates or noscript fallbacks.
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const lines=[];let node,size=0;
 while((node=walker.nextNode())&&size<16000){const el=node.parentElement;
  if(!el||el.closest('script,style,noscript,input,textarea,[contenteditable], [hidden]')||!visible(el))continue;
  const t=node.textContent.trim();if(t){lines.push(t);size+=t.length;}
 }
 return {stage:'已读取日常Chrome业务页面',url:current.origin+current.pathname,pageText:lines.join('\n'),controls,blockedRequests:[],rows:[],note:'复用日常Chrome登录态；仅当前批准应用的可见内容。浏览器正常加载网络请求，不拦截登录或权限初始化。'};
}
