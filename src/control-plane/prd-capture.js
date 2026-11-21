// Runs inside the website frame. Only known UI copy and decorative assets
// are allowed to survive the screenshot's default masking.
export function describePrdCapture({ attribute, secretSelector, brandedLabels }) {
  const bounds = target => {
    const r=target.getBoundingClientRect();
    return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};
  };
  const visible = r=>r.width>0&&r.height>0&&r.x<innerWidth&&r.y<innerHeight&&r.x+r.width>0&&r.y+r.height>0;
  const sections=[...document.querySelectorAll('header, nav, aside, [role="menu"], table, [role="table"], [role="grid"], [role="dialog"], [role="tabpanel"], form, footer')]
    .map(element=>({kind:element.matches('[role=dialog]')?'dialog':element.matches('[role=tabpanel]')?'tabpanel':element.matches('[role=table],[role=grid]')?'table':element.tagName.toLowerCase(),...bounds(element)}))
    .filter(visible).slice(0,40);
  const controls=[], placeholders=[], assets=[], glyphs=[];
  if (!attribute) return {viewportWidth:innerWidth,viewportHeight:innerHeight,sections,controls,placeholders,assets,glyphs};
  const terms=new Set(('首页 工作台 菜单 基础信息 订单管理 订单列表 订单详情 人工订单 手工订单 代客下单 运营管理 渠道任务 活动管理 财务管理 策略管理 访销管理 门店管理 门店审核 门店未审核 商品管理 预算管理 促销管理 促销活动 活动列表 活动详情 审批管理 订单编号 商品名称 商品编码 经销商 经销商名称 组织架构 订单状态 审批状态 状态 名称 编号 类型 数量 规格 单位 操作 创建时间 更新时间 开始时间 结束时间 查询 搜索 重置 清空 新增 添加 编辑 删除 查看 详情 保存 提交 确定 取消 关闭 返回 导入 导出 上一页 下一页 标题 序号 更新日志 发货状态 DMS订单编号 SAP订单编号 DMS订单号 SAP订单号 经销商编码 订单审批记录 订单审批 订单拆单 经销商下单 订单返点量 渠道量小店返量 保证金下单检查白名单 收起导航 选项管理 新建 更多 搜索菜单或功能 页 前往 暂无数据 今天 最近7天') .split(' '));
  for(const label of brandedLabels??[])terms.add(label);
  const shapeTags=new Set(['path','g','use','circle','rect','line','polyline','polygon','ellipse','defs','clippath','symbol','title','desc']);
  const approvedBrand = (element, rect) => {
    if(!element.matches('img') || rect.width>360 || rect.height>100 || rect.y>150) return false;
    try {
      const src=new URL(element.currentSrc||element.src,location.href);
      const group=element.closest('header,nav,aside,[role=banner],[role=navigation],[class*="header" i],[class*="logo" i],[class*="brand" i]');
      if(!group || element.closest('[class*="avatar" i],[class*="user-info" i]'))return false;
      if(src.protocol==='data:') return element.matches('[class*="logo" i],[class*="brand" i] img,[class*="logo" i] img')
        && /^data:image\/(?:png|webp|gif);base64,/i.test(src.href);
      return src.origin===location.origin && !src.search && !src.hash
        && /(?:^|[\/_.-])(?:logo(?:img|image|icon|mark|type)?|brand(?:logo|mark)?|favicon)(?:[\/_.-]|$)/i.test(src.pathname)
        && /\.(?:png|svg|gif|webp|jpe?g|ico)$/i.test(src.pathname);
    }catch{return false;}
  };
  const safeShape = node=>shapeTags.has(node.localName.toLowerCase())
    && ![...node.attributes].some(a=>/^(?:on|style)/i.test(a.name)||/url\s*\(/i.test(a.value));
  const localShape = node => {
    const reference=node.getAttribute('href')??node.getAttribute('xlink:href')??'';
    const target=/^#[a-z0-9_-]+$/i.test(reference)?document.getElementById(reference.slice(1)):null;
    return target && safeShape(target) && [...target.querySelectorAll('*')].every(e=>safeShape(e)&&e.localName!=='use');
  };
  const approvedIcon=(element,rect)=>element.matches('svg')&&rect.width<=48&&rect.height<=48
    && !element.closest('td,[role=cell],[class*="avatar" i]')
    && [...element.querySelectorAll('*')].every(node=>safeShape(node)&&(node.localName!=='use'||localShape(node)));
  for(const element of document.querySelectorAll('body *')){
    if(element.closest(secretSelector)||element.matches('script,style,textarea,option,[contenteditable]'))continue;
    const geometry=bounds(element), style=getComputedStyle(element);
    if(!visible(geometry)||style.visibility!=='visible')continue;
    if(approvedBrand(element,geometry)||approvedIcon(element,geometry)){
      element.setAttribute(attribute+'-asset',String(assets.length));
      assets.push(style.color);
      continue;
    }
    if(geometry.width<=48&&geometry.height<=48 && !element.closest('td,[role=cell],[class*="avatar" i]')){
      const icon=getComputedStyle(element,'::before');
      if(/^(?:"[\uE000-\uF8FF]"|'[\uE000-\uF8FF]')$/.test(icon.content)&&/icon/i.test(icon.fontFamily)){
        element.setAttribute(attribute+'-glyph',String(glyphs.length));
        glyphs.push(icon.color);
      }
    }
    const placeholder=element.matches('input:not([type=password])')?element.getAttribute('placeholder')?.trim():null;
    if(placeholder && (terms.has(placeholder)||terms.has(placeholder.replace(/^(?:请输入|请选择|输入|选择)/,'')))){
      element.setAttribute(attribute+'-placeholder',String(placeholders.length));
      placeholders.push(getComputedStyle(element,'::placeholder').color);
    }
    if(element.closest('[class*="avatar" i]'))continue;
    const direct=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
    if(direct.length!==1)continue;
    const text=direct[0].textContent.trim();
    const rowAction=element.closest('button,a,[role=button]')&&['查看','详情','编辑','删除'].includes(text);
    if(element.closest('td,[role=cell]')&&!rowAction)continue;
    const brandTitle=element.closest('[class*="app-logo" i],[class*="brand-name" i],[class*="logo-title" i],.shell-brand')
      && geometry.y<100&&/^[\p{L}\p{M}][\p{L}\p{M} .&-]{1,24}$/u.test(text);
    if(!terms.has(text.replace(/\s+/g,'').replace(/[:：]$/,''))&&!brandTitle)continue;
    const range=document.createRange();
    range.selectNodeContents(direct[0]);
    const box=bounds(range);
    if(!visible(box))continue;
    const positioned=style.position!=='static';
    element.setAttribute(attribute,String(controls.length));
    controls.push({text,...geometry,color:style.color,fontFamily:style.fontFamily,fontSize:style.fontSize,
      left:box.x-geometry.x+element.scrollLeft-element.clientLeft,
      top:box.y-geometry.y+element.scrollTop-element.clientTop,positioned});
  }
  return {viewportWidth:innerWidth,viewportHeight:innerHeight,sections,controls,placeholders,assets,glyphs};
}
