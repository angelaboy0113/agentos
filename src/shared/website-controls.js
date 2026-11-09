// Fixed DOM adapter shared by all applications; no model-supplied selectors or scripts.
export const websiteControls='.el-collapse-item__header,.ant-collapse-header,div[aria-expanded],i[aria-expanded],div,span,i,.ant-card-hoverable,.ant-table-row-expand-icon,.el-table__expand-icon,a,[role="link"],button,select,[role="button"],input:not([type="password"]):not([type="hidden"]),[role="menuitem"],[role="treeitem"],[role="tab"],[role="option"],[role="gridcell"],[role="combobox"],[role="checkbox"],[role="radio"],[aria-haspopup],.el-date-editor,.ant-picker,.ant-calendar-picker,.ant-calendar-date,.ant-calendar-prev-month-btn,.ant-calendar-next-month-btn,.ant-calendar-prev-year-btn,.ant-calendar-next-year-btn,.ant-calendar-ok-btn,.el-submenu__title,.ant-menu-submenu-title,.el-select-dropdown__item,.ant-select-item-option,.el-date-picker td.available,.el-date-range-picker td.available,.el-month-table td,.el-year-table td,.ant-picker-cell-in-view:not(.ant-picker-cell-disabled),.el-pagination li,.ant-pagination-item,span,tr[data-row-key],[role="row"][data-row-key]';
export function controlMetadata(el,{readNavigationSelectors=[]}={}){
 const visible=el.isConnected&&!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
 if(!visible||el.disabled||el.getAttribute('aria-disabled')==='true'||el.matches('.disabled,.is-disabled,.ant-picker-cell-disabled,.ant-calendar-disabled-cell')||el.closest('.ant-calendar-disabled-cell,.ant-picker-cell-disabled')||el.closest('[contenteditable="true"],[data-sensitive],[data-agentos-secret]'))return {visible:false};
 const tag=el.tagName.toLowerCase(),calendar=el.closest('.el-picker-panel,.ant-picker-panel,.ant-calendar-picker-container,.ant-calendar,[role="grid"]'),option=el.matches('[role="option"],.el-select-dropdown__item,.ant-select-item-option'),pagination=el.closest('.el-pagination,.ant-pagination,[role="navigation"][aria-label*="pag" i]');
 const row=el.matches('tr[data-row-key],[role="row"][data-row-key]');
 const reviewedNavigation=readNavigationSelectors.some(selector=>el.matches(selector));
 const primaryLabel=reviewedNavigation?(el.getAttribute('aria-label')||el.getAttribute('title')||el.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > p')?.innerText):null;
 const title=el.matches('[role="menuitem"],[role="treeitem"]')?el.querySelector(':scope > .el-submenu__title,:scope > .ant-menu-submenu-title'):null;
 let label=(primaryLabel||(title??el).innerText||el.getAttribute('placeholder')||el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('name')||el.id||'').trim().slice(0,100);
 if(/^(?:搜\s*索|查\s*询|重\s*置)$/.test(label))label=label.replace(/\s/g,'');
 const localExpansion=/^(?:展开|收起)(?:全部|筛选|筛选条件|更多)?(?:\s*[（(](?:还有|共)?\s*\d+\s*(?:项|个)?[）)])?\s*[⌄⌃▾▴▼▲∨∧]?$/.test(label)||/^(?:expand|collapse)(?: all| filters)?(?:\s*\(\d+\))?$/i.test(label);
 const customContainer=['div','i'].includes(tag)&&!el.matches('[role],.el-submenu__title,.ant-menu-submenu-title,.ant-card-hoverable,.el-date-editor,.ant-picker,.ant-calendar-picker');
 const localInteractive=el.matches('button,[role=button],[aria-expanded]')||el.hasAttribute('onclick')||getComputedStyle(el).cursor==='pointer';
 // Never turn a container/ordinary paragraph into an action because its descendants contain a label.
 if(customContainer&&!reviewedNavigation&&!(el.matches('.ant-table-row-expand-icon,.el-table__expand-icon')||panelCandidate(el)||localExpansion&&localInteractive&&el.querySelectorAll('button,a,input,select,[role=button]').length===0))return {visible:true,label,type:null};
 function panelCandidate(node){return node.matches('.el-collapse-item__header,.ant-collapse-header');}
 const fieldGroup=el.closest('.el-form-item,.ant-form-item,.el-col,.ant-col,[role="group"],label');
 const singleField=fieldGroup&&[...fieldGroup.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(x=>x.getClientRects().length).length===1;
 const localLabel=singleField?fieldGroup.innerText?.trim():'';
 const fieldLabel=fieldGroup?.querySelector('.el-form-item__label,.ant-form-item-label,label')?.innerText?.trim()||(localLabel&&localLabel.length<=100?localLabel:'');
 if(tag==='input'&&fieldLabel)label=fieldLabel+' / '+label;
 const expansion=el.matches('.ant-table-row-expand-icon,.el-table__expand-icon');
 if(expansion)label=(el.classList.contains('ant-table-row-expanded')||el.classList.contains('el-table__expand-icon--expanded')||el.getAttribute('aria-expanded')==='true'?'收起':'展开')+'行详情：'+(el.closest('tr,[role="row"]')?.innerText??'').trim().slice(0,70);
 const panel=el.matches('.el-collapse-item__header,.ant-collapse-header');
 if(panel)label=(el.classList.contains('is-active')||el.getAttribute('aria-expanded')==='true'?'收起':'展开')+(el.closest('form,.el-form,.ant-form')?'筛选：':'面板：')+label;
 const dismiss=!!el.closest('[role="dialog"],.el-dialog,.el-drawer,.ant-modal,.ant-drawer')&&(el.matches('.el-dialog__headerbtn,.el-drawer__close-btn,.ant-modal-close,.ant-drawer-close,[aria-label="Close" i],[aria-label="关闭"]')||/^(关闭|取消|返回|close|cancel|back)$/i.test(label));
 const picker=el.matches('.el-date-editor,.ant-picker,.ant-calendar-picker')||el.matches('input[readonly]')&&!!el.closest('.el-date-editor,.ant-picker,.ant-calendar-picker,.el-select,[role="combobox"]');
 if(el.matches('.el-date-editor,.ant-picker,.ant-calendar-picker')&&el.querySelector('input:not([disabled])'))return {visible:true,label,type:null};
 if(el.matches('.el-date-editor,.ant-picker,.ant-calendar-picker'))label=fieldLabel||el.getAttribute('aria-label')||'日期范围选择';
 if(dismiss)label='关闭当前弹窗';
 if(calendar&&!label){const c=String(el.className);label=/d-arrow-left|prev-year|super-prev/.test(c)?'上一年':/d-arrow-right|next-year|super-next/.test(c)?'下一年':/arrow-left|prev-month|prev-btn/.test(c)?'上个月':/arrow-right|next-month|next-btn/.test(c)?'下个月':'';}
 if(calendar&&el.matches('td,[role="gridcell"]')){const header=el.closest('.el-date-range-picker__content')?.querySelector('.el-date-range-picker__header')??calendar.querySelector('.el-date-picker__header,.ant-picker-header-view,.ant-calendar-header');label='日期选择：'+(el.getAttribute('title')||el.closest('td')?.getAttribute('title')||(header?.innerText??'').trim())+' '+label;}
 if(pagination&&!label)label=tag==='input'?'前往页码':el.matches('.btn-next,.ant-pagination-next')?'下一页':el.matches('.btn-prev,.ant-pagination-prev')?'上一页':'';
 if(!label)return {visible:true,label,type:null};
 const mutation=/立即执行|执行一次|单次执行|立即运行|运行一次|重放|重发|重新发送|试运行|测试接口|接口测试|新增|创建|保存|修改|编辑|删除|启动|停止|触发|重跑|终止|发布|启用|禁用|提交|支付|注销|退出|作废|驳回|撤回|取消订单|关闭订单|确认收货|\b(add|create|save|update|edit|delete|remove|start|stop|trigger|execute|run|restart|reset|kill|publish|enable|disable|submit|approve|pay|logout|cancel|resend|replay)\b/i;
 const navigation=reviewedNavigation||el.matches('.ant-card-hoverable,[role="link"],[role="menuitem"],[role="treeitem"],[role="tab"],.el-submenu__title,.ant-menu-submenu-title');
 let type=null,kind='action';
 if(tag==='input'){
  const identity=[label,el.name,el.id,el.placeholder,el.getAttribute('aria-label')].join(' ');
  if(/password|passwd|secret|token|credential|authorization|api.?key|app.?key|密码|令牌|密钥/i.test(identity))return {visible:true,label,type:null};
  if(picker){type='read-action';kind='picker';}
  else if(!el.readOnly&&/^(text|search|date|datetime-local|number|month|week|time|tel)$/.test(el.type)){type='search';kind='field';}
 }else if(tag==='select'){type='select';kind='field';}
 else if(picker){type='read-action';kind='picker';}
 else if(expansion){type='read-action';kind='expansion';}
 else if(panel){type='read-action';kind='panel';}
 else if(dismiss){type='read-action';kind='dismiss';}
 else if(option||calendar&&el.matches('button,td,[role="gridcell"]')||pagination){type='read-action';kind=option?'option':calendar?'calendar':'pagination';}
 else if(navigation){type='read-action';kind='navigation';}
 else if(tag==='a'||row||el.matches('[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="dialog"]')){type='read-action';}
 else if(localExpansion){type='read-action';kind='expansion-toggle';}
 else if(/^(?:更多|更多筛选|高级筛选|高级搜索|展开筛选|收起筛选|重置|查询|搜索|查看|详情|刷新|展开|收起|确定|返回|下一页|上一页|search|query|view|detail|refresh|next|previous|more|reset)$/i.test(label)||/查看|详情|日志/.test(label)){type='read-action';}
 if(tag==='span'&&!picker&&!calendar&&!option&&!expansion&&!panel&&(el.closest('button,a,[role="button"],[role="menuitem"],.el-select-dropdown__item')||!localExpansion&&!(/^(更多|更多筛选|高级筛选|高级搜索|展开筛选|收起筛选|返回)$/).test(label)))type=null;
 if(title||el.matches('[role="tab"]')&&[...el.querySelectorAll('button,[role="button"]')].some(child=>child.innerText?.trim()===label))type=null;
 // Fields, options and date cells change local query state; server writes remain independently blocked.
 const blocked=!['field','option','calendar','pagination','picker','dismiss','panel','expansion'].includes(kind)&&(mutation.test(label)||(!navigation&&/审批/.test(label)));
 if(blocked)type=null;
 return {visible:true,label:row?'行详情：'+label:label,type,kind,blocked,...(type==='select'?{options:[...el.options].slice(0,100).map(x=>({value:x.value,label:x.textContent}))}:{})};
}
export function websiteFields({secretSelector,full=false}){
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 return [...document.querySelectorAll('input,textarea,select')].filter(e=>visible(e)&&!e.matches(secretSelector)&&!e.closest('[data-sensitive],[data-agentos-secret]')).slice(0,full?undefined:101).map(e=>{
  const group=e.closest('.el-form-item,.ant-form-item,.el-col,.ant-col,label,[role="group"]');
  const labels=[...group?.querySelectorAll('label,.el-form-item__label,.ant-form-item-label,span')??[]].filter(n=>n!==e&&/[:：]$/.test(n.innerText?.trim()??''));
  const local=group&&[...group.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible).length===1?group.innerText?.trim():'';
  const label=(e.getAttribute('aria-label')||labels[0]?.innerText||e.labels?.[0]?.innerText||(local&&local.length<=100?local:'')||e.placeholder||e.name||e.id||'字段').trim().slice(0,100);
  if(/password|passwd|secret|token|credential|authorization|api.?key|app.?key|密码|令牌|密钥/i.test([label,e.name,e.id,e.placeholder].join(' ')))return {label,value:'[已隐藏]',readOnly:true,disabled:!!e.disabled};
  return {label,value:String(e.tagName==='SELECT'?e.selectedOptions[0]?.textContent??e.value:e.value).slice(0,full?undefined:500),readOnly:!!e.readOnly,disabled:!!e.disabled};
 });
}

// Maintainer-reviewed single component selectors only, never model selectors or JS.
export function validateWebsiteNavigationSelectors(value){
 if(!Array.isArray(value)||value.length>32||value.some(s=>typeof s!=='string'||s.length>200||! /^(?:[.#][A-Za-z][A-Za-z0-9_-]*)(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/.test(s)||/password|secret|token|credential/i.test(s)))throw new Error('只读导航控件必须为审核后的固定class/id选择器');
 return value;
}
