// Runs in the page. Preserve native UI ink for semantic chrome and known static copy.
export function describePrdCapture({ attribute, secretSelector, brandedLabels }) {
  const bounds = target => {
    const r=target.getBoundingClientRect();
    return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};
  };
  const visible = r=>r.width>0&&r.height>0&&r.x<innerWidth&&r.y<innerHeight&&r.x+r.width>0&&r.y+r.height>0;
  const sections=[...document.querySelectorAll('header, nav, aside, [role="menu"], table, [role="table"], [role="grid"], [role="dialog"], [role="tabpanel"], form, footer')]
    .map(element=>({kind:element.matches('[role=dialog]')?'dialog':element.matches('[role=tabpanel]')?'tabpanel':element.matches('[role=table],[role=grid]')?'table':element.tagName.toLowerCase(),...bounds(element)}))
    .filter(visible).slice(0,40);
  const controls=[], placeholders=[], assets=[], glyphs=[], backgrounds=[], brandRegions=[], samples=[];
  const protect = ({x,y,width,height})=>{
    const left=Math.max(0,x),top=Math.max(0,y),right=Math.min(innerWidth,x+width),bottom=Math.min(innerHeight,y+height);
    if(right>left&&bottom>top)brandRegions.push({x:left/innerWidth,y:top/innerHeight,width:(right-left)/innerWidth,height:(bottom-top)/innerHeight});
  };
  if (!attribute) return {viewportWidth:innerWidth,viewportHeight:innerHeight,sections,controls,placeholders,assets,glyphs,backgrounds,brandRegions};
  const gridSelector='table,[role="grid"],[role="table"],.el-table,.ant-table,.vxe-table';
  const cellSelector='td,th[scope=row],[role="rowheader"],[role="cell"],[role="gridcell"]';
  const headerSelector='th:not([scope=row]),[role="columnheader"]';
  const rowSelector='tr,[role="row"]';
  const grids=[...document.querySelectorAll(gridSelector)].filter(grid=>{
    if(grid.parentElement?.closest(gridSelector)||grid.closest(secretSelector))return false;
    return visible(bounds(grid))&&[...grid.querySelectorAll(headerSelector)].some(header=>{
      const box=bounds(header);
      if(!visible(box))return false;
      const x=Math.min(innerWidth-1,Math.max(0,box.x+box.width/2));
      const y=Math.min(innerHeight-1,Math.max(0,box.y+box.height/2));
      return header.contains(document.elementFromPoint(x,y));
    });
  });
  const rowCells=new Map();
  let visibleRows=0;
  for(const grid of grids){
    const headers=[...grid.querySelectorAll(headerSelector)].map(el=>el.textContent.trim());
    for(const row of grid.querySelectorAll(rowSelector)){
      if(row.closest('thead')||row.matches('.ant-table-placeholder,.ant-table-measure-row,.el-table__empty-block')||!visible(bounds(row)))continue;
      const cells=[...row.children].filter(cell=>cell.matches(cellSelector));
      if(!cells.length||cells.length===1&&headers.length>1&&Number(cells[0].getAttribute('colspan')??cells[0].getAttribute('aria-colspan'))>1)continue;
      if(!cells.some(cell=>cell.textContent.trim()&&!/^(?:暂无数据|没有数据|无数据|No data|No results)$/i.test(cell.textContent.trim())))continue;
      visibleRows++;
      let column=0;
      for(const cell of cells){
        const ariaColumn=Number(cell.getAttribute('aria-colindex'));
        const header=headers[ariaColumn>0?ariaColumn-1:column]??'';
        rowCells.set(cell,{header,number:visibleRows});
        column+=Number(cell.getAttribute('colspan'))||1;
      }
    }
  }
  const tableCapture={tables:grids.length,visibleRows,sampleFields:0,preservedStates:0};
  const states=new Set(('启用 停用 已启用 已停用 有效 无效 待审核 待审批 审批中 审核中 待执行 执行中 进行中 已执行 已审核 已审批 已发布 已批准 已生效 未生效 未开始 已完成 未完成 待提交 草稿 已提交 已驳回 已拒绝 已关闭 已取消 已撤销 已过期 已结束 已上账 待上账 已匹配 未匹配 可申请 已结案 活跃 非活跃 不活跃 Active Inactive Pending Approved Rejected Completed Draft Open Closed').split(' '));
  const sampleValue=({header,number})=>{
    const code=String(number).padStart(3,'0');
    if(/序号|^#$/i.test(header))return String(number);
    if(/手机号|电话|联系号码|phone|mobile/i.test(header))return '000-0000-0000';
    if(/邮箱|email/i.test(header))return 'example@example.invalid';
    if(/订单.*(?:号|码)|order.*(?:id|no|number)/i.test(header))return 'ORDER-DEMO-'+code;
    if(/活动.*(?:号|码)|activity.*(?:id|code)/i.test(header))return 'ACT-DEMO-'+code;
    if(/编号|编码|代码|识别码|号$|码$|\b(?:id|code|number)\b/i.test(header))return 'DEMO-'+code;
    if(/金额|额度|余额|单价|amount|price/i.test(header))return '100.00';
    if(/日期|时间|date|time/i.test(header))return '2026-01-01';
    if(/数量|件数|quantity/i.test(header))return String(number+1);
    if(/活动名|活动标题/i.test(header))return '示例活动 '+code;
    if(/客户|经销商|门店|供应商|组织|customer|dealer/i.test(header))return '示例单位 '+code;
    if(/账号|申请人|联系人|负责人|创建人|姓名|owner|user/i.test(header))return '示例人员 '+code;
    return '示例 '+code;
  };
  const sampled=new Set();
  const sampleInk = (element,node,geometry,style,text)=>{
    element.setAttribute(attribute+'-sample',String(samples.length));
    const ink=document.createRange();
    ink.selectNodeContents(node);
    const inkBox=bounds(ink);
    const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
    samples.push({text,color:style.color,ink:style.webkitTextFillColor||style.color,
      left:Math.max(0,inkBox.x-geometry.x),
      top:Math.max(0,inkBox.y-geometry.y-Math.round(Math.max(0,lineHeight-inkBox.height)/2))});
  };
  const terms=new Set(('首页 工作台 菜单 基础信息 订单管理 订单列表 订单详情 人工订单 手工订单 代客下单 运营管理 渠道任务 活动管理 财务管理 策略管理 访销管理 门店管理 门店审核 门店未审核 商品管理 预算管理 促销管理 促销活动 活动列表 活动详情 审批管理 订单编号 商品名称 商品编码 经销商 经销商名称 组织架构 订单状态 审批状态 状态 名称 编号 类型 数量 规格 单位 操作 创建时间 更新时间 开始时间 结束时间 查询 搜索 重置 清空 新增 添加 编辑 删除 查看 详情 保存 提交 确定 取消 关闭 返回 导入 导出 上一页 下一页 标题 序号 更新日志 发货状态 DMS订单编号 SAP订单编号 DMS订单号 SAP订单号 经销商编码 订单审批记录 订单审批 订单拆单 经销商下单 订单返点量 渠道量小店返量 保证金下单检查白名单 收起导航 选项管理 新建 更多 搜索菜单或功能 页 前往 暂无数据 今天 最近7天') .split(' '));
  const fieldTerms = new Set(('方案管理 方案列表 方案详情 方案名称 方案编号 方案状态 方案类型 申请人 申请日期 申请金额 预算来源 预算组织 下发预算 可用额度 可用金额 已用额度 占用额度 分配额度 分配总额 分配金额 活动大类 费用类型 使用组织 分配组织 生效日期 失效日期 审核人 提交人 操作时间 优惠类型 补贴金额 补贴状态 促销规则').split(' '));
  const shellTerms=('门店主数据 月度门店目标 门店提质 店效执行数据 门店质量管理 算账工具 促销员管理 关联促销员 促销员排班 促销员考勤明细 规则配置 提成规则 活动产品 推送群配置 用户权限 人员数据视图 外部用户 系统 数据统计 退出登录 组织架构 按组织筛选门店 全部门店 当前数据 月结版本 当前结果 月结结果 门店 客户 全部状态 活跃 非活跃 不活跃 99价值链:全部 有无导购:全部 有导门店 无导门店 更多操作 每页 条 上一页 下一页').split(' ');
  for(const label of [...shellTerms,...(brandedLabels??[])])terms.add(label);
  const searchPlaceholders = new Set(['搜索门店/经销商/编码/人员姓名（支持拼音全拼、首字母）']);
  const fieldLabelSelector='label,legend,th,[role="columnheader"],[class*="form-item__label"],[class*="form-item-label"]';
  const chromeSelector='nav,[role="navigation"],[role="menuitem"],[aria-current="page"],[role="tab"],.el-menu-item,.ant-menu-item,.ant-menu-submenu-title,.el-submenu__title,.el-collapse-item__header,.ant-collapse-header,.panel-title,[class$="-section-title"],[class*="breadcrumb" i]';
  const sensitiveValue='input,select,textarea,option,[contenteditable],[class*="avatar" i],[class*="user-info" i],[class*="user-name" i],.el-select__selected-item,.ant-select-selection-item,[role="option"]';
  const staticLabel = text => /^[\p{L}][\p{L}\p{M} /·&：:（）()—-]{0,43}$/u.test(text);
  const shapeTags=new Set(['path','g','use','circle','rect','line','polyline','polygon','ellipse','defs','clippath','symbol','title','desc']);
  const brandElement='[class*="logo" i],[class*="brand" i]';
  const brandSlot='.default-logo,.app-logo,.brand-logo,.brand-mark,.site-logo,.header-logo,[data-role="app-logo"]';
  const isBrandBox = (element, rect) => rect.width<=360 && rect.height<=100 && rect.y<=150
    && element.closest('header,nav,aside,[role=banner],[role=navigation],[class*="header" i],'+brandElement)
    && !element.closest('[class*="avatar" i],[class*="user-info" i]');
  const safeBrandUrl = (raw,element) => {
    try {
      const src=new URL(raw,location.href);
      return src.origin===location.origin && !src.username && !src.password && !src.search && !src.hash
        && (element.closest(brandSlot) || /(?:^|[\/_.-])(?:logo(?:img|image|icon|mark|type)?|brand(?:logo|mark)?|favicon)(?:[\/_.-]|$)/i.test(src.pathname))
        && /\.(?:png|svg|gif|webp|jpe?g|ico)$/i.test(src.pathname);
    }catch{return false;}
  };
  const approvedBrand = (element, rect) => {
    if(!element.matches('img')||!element.complete||!element.naturalWidth||!isBrandBox(element,rect))return false;
    const src=element.currentSrc||element.src;
    return /^data:image\/(?:png|webp|gif);base64,/i.test(src)
      ? Boolean(element.closest(brandElement)) : safeBrandUrl(src,element);
  };
  const safeShape = node=>shapeTags.has(node.localName.toLowerCase())
    && ![...node.attributes].some(a=>/^(?:on|style)/i.test(a.name)||/url\s*\(/i.test(a.value));
  const localShape = node => {
    const reference=node.getAttribute('href')??node.getAttribute('xlink:href')??'';
    const target=/^#[a-z0-9_-]+$/i.test(reference)?document.getElementById(reference.slice(1)):null;
    return target && safeShape(target) && [...target.querySelectorAll('*')].every(e=>safeShape(e)&&e.localName!=='use');
  };
  const actionCell=element=>/^(?:操作|Actions?|Operations?)$/i.test(rowCells.get(element.closest(cellSelector))?.header??'');
  const iconLocation=element=>!element.closest('[class*="avatar" i]')&&(!element.closest(cellSelector)||actionCell(element));
  const approvedRasterIcon=(element,rect)=>{
    if(!element.matches('img')||!actionCell(element)||!element.closest('a,button,[role="button"]')
      ||!iconLocation(element)||!element.complete||rect.width>32||rect.height>32
      ||element.naturalWidth<8||element.naturalHeight<8||element.naturalWidth>32||element.naturalHeight>32)return false;
    const source=element.currentSrc||element.src;
    if(/^data:image\/(?:png|gif|webp);base64,[A-Za-z0-9+/=]{20,5000}$/i.test(source))return true;
    try{
      const url=new URL(source,location.href);
      return url.origin===location.origin&&!url.search&&!url.hash&&!url.username&&!url.password
        &&/\/(?:assets|icons?)\/(?:icon[-_])?(?:view|detail|edit|delete|copy|download|upload|enable|disable|up|down|select|more)(?:[._-][a-z0-9_-]{4,32})?\.(?:png|gif|webp)$/i.test(url.pathname);
    }catch{return false;}
  };
  const approvedIcon=(element,rect)=>element.matches('svg')&&rect.width<=48&&rect.height<=48
    && iconLocation(element)
    && [...element.querySelectorAll('*')].every(node=>safeShape(node)&&(node.localName!=='use'||localShape(node)));
  const paginationParts = new Set();
  for (const button of document.querySelectorAll('button,[role="button"]')) {
    if (!/^(?:上一页|上页|Previous)$/i.test(button.textContent.trim())) continue;
    const cluster = button.parentElement;
    if (![...cluster.children].some(item=>item.matches('button,[role="button"]')
      && /^(?:下一页|下页|Next)$/i.test(item.textContent.trim()))) continue;
    for (const item of cluster.children) {
      if (!item.matches('button,[role="button"]') && /^\d+\s*\/\s*\d+$/.test(item.textContent.trim())) paginationParts.add(item);
    }
  }
  for(const element of document.querySelectorAll('body *')){
    if(element.closest(secretSelector)||element.matches('script,style,textarea,option,[contenteditable]'))continue;
    const geometry=bounds(element), style=getComputedStyle(element);
    if(!visible(geometry)||style.visibility!=='visible')continue;
    const brandImage=approvedBrand(element,geometry);
    const background=style.backgroundImage.match(/^url\("([^"]+)"\)$/)?.[1];
    if(background&&element.matches(brandElement)&&isBrandBox(element,geometry)&&safeBrandUrl(background,element)){
      element.setAttribute(attribute+'-background',String(backgrounds.length));
      backgrounds.push(background);
      protect(geometry);
    }
    if(brandImage||approvedIcon(element,geometry)||approvedRasterIcon(element,geometry)){
      element.setAttribute(attribute+'-asset',String(assets.length));
      assets.push(style.color);
      if(brandImage)protect(geometry);
      continue;
    }
    if(geometry.width<=48&&geometry.height<=48 && iconLocation(element)){
      const icon=getComputedStyle(element,'::before');
      if(/^(?:"[\uE000-\uF8FF]"|'[\uE000-\uF8FF]')$/.test(icon.content)&&/icon/i.test(icon.fontFamily)){
        element.setAttribute(attribute+'-glyph',String(glyphs.length));
        glyphs.push(icon.color);
      }
    }
    const placeholder=element.matches('input:not([type=password])')?element.getAttribute('placeholder')?.trim():null;
    if(placeholder && (searchPlaceholders.has(placeholder)||terms.has(placeholder)||terms.has(placeholder.replace(/^(?:请输入|请选择|输入|选择)/,'')) || fieldTerms.has(placeholder.replace(/^(?:请输入|请选择|输入|选择)/,'')))){
      element.setAttribute(attribute+'-placeholder',String(placeholders.length));
      placeholders.push(getComputedStyle(element,'::placeholder').color);
    }
    if(element.closest(sensitiveValue))continue;
    const direct=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
    if(direct.length!==1)continue;
    const text=direct[0].textContent.trim();
    const rowAction=actionCell(element)&&element.closest('button,a,[role=button]')&&/^(?:查看(?:详情|明细|记录|日志)?|详情|编辑|删除|修改|复制|下载|上传|审核|撤回|上账|启用|停用|更多|view(?: details)?|details?|edit|delete|copy|download|upload|review|more)$/i.test(text);
    const cell=element.closest(cellSelector);
    const row=rowCells.get(cell);
    const visibleState=row&&/状态|进度|活跃度|\bstatus\b/i.test(row.header)&&states.has(text);
    if(cell&&!rowAction&&!visibleState){
      if(row&&!sampled.has(cell)&&!element.closest('button,[role="button"]')){
        sampled.add(cell);
        sampleInk(element,direct[0],geometry,style,sampleValue(row));
      }
      continue;
    }
    if(visibleState)tableCapture.preservedStates++;
    const brandTitle=element.closest('[class*="app-logo" i],[class*="brand-name" i],[class*="logo-title" i],.shell-brand')
      && geometry.y<100&&/^[\p{L}\p{M}][\p{L}\p{M} .&-]{1,24}$/u.test(text);
    if (paginationParts.has(element)) {
      sampleInk(element,direct[0],geometry,style,'1 / 10');
      continue;
    }
    const normalized = text.replace(/\s+/g,'').replace(/：/g,':').replace(/:$/,'');
    const fieldLabel = element.closest(fieldLabelSelector);
    const semanticChrome = element.closest(chromeSelector);
    const actionLabel = element.closest('button,[role="button"]')&&(
      /^(?:查看|关闭|返回|刷新|导出|查询|搜索|展开|收起|确认|取消|应用|下载|批量|全量)[\p{L} ]{1,16}$/u.test(text)
      || /^(?:[\p{L}]{1,12})(?:后调整|调整|上账)$/u.test(text));
    // Cells, selection values and account badges stay covered. Ordinary
    // menu, collapse and table-header labels keep their original typography.
    if(!terms.has(normalized)&&!brandTitle&&!visibleState&&!rowAction&&!(
      ((fieldLabel||semanticChrome||actionLabel)&&staticLabel(text)) || (element.closest('h1,h2,h3,[role="heading"]')&&fieldTerms.has(normalized))))continue;
    const range=document.createRange();
    range.selectNodeContents(direct[0]);
    const box=bounds(range);
    if(!visible(box))continue;
    if(brandTitle)protect(box);
    element.setAttribute(attribute,String(controls.length));
    controls.push({text,...geometry,color:style.color,ink:style.webkitTextFillColor||style.color,
      fontFamily:style.fontFamily,fontSize:style.fontSize});
  }
  tableCapture.sampleFields=sampled.size;
  return {viewportWidth:innerWidth,viewportHeight:innerHeight,sections,controls,placeholders,assets,glyphs,backgrounds,brandRegions,samples,tableCapture};
}
