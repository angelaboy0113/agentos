const plain = content => ({tag:'plain_text',content});
const navigation = new WeakMap();

export function pointsStorePages(card) {
  const pages = [];
  const base = structuredClone(card);
  const elements = base.body.elements;
  const start = elements.findIndex(element => element?.tag === 'collapsible_panel');
  if (start < 0) return null;
  const panels = elements.slice(start);
  for (const panel of panels) {
    if (panel?.tag !== 'collapsible_panel' || typeof panel.header?.title?.content !== 'string'
      || !Array.isArray(panel.elements) || !panel.elements.length) return null;
    for (const row of panel.elements) {
      if (row?.tag !== 'column_set' || row.columns?.length !== 2) return null;
      pages.push({ title:panel.header.title.content.replace(/\s*·\s*\d+\s*款$/u,''), row });
    }
  }
  if (pages.length < 2) return null;
  base.body.elements = elements.slice(0,start).filter(element => element?.tag !== 'markdown' || element.text_size !== 'notation');
  return {base, pages};
}

export function pointsStorePageCard(catalog, pageIndex = 0, revision = 0) {
  const {base,pages} = catalog;
  const card = structuredClone(base);
  const {title,row} = pages[pageIndex];
  const button = (label,step) => ({
    tag:'button',type:step===1?'primary_filled':'default',width:'fill',text:plain(label),
    disabled:pageIndex+step<0||pageIndex+step>=pages.length,
    behaviors:[{type:'callback',value:{action:'points_store_page',step,revision}}],
  });
  card.header.subtitle = plain('礼品翻组 · 试兑预览');
  card.config.summary = {content:'AgentOS 积分商城 · 礼品翻组'};
  card.body.elements = [
    ...card.body.elements,
    {tag:'markdown',content:`**${title}**  ·  第 ${pageIndex+1} / ${pages.length} 组`},
    row,
    {tag:'column_set',flex_mode:'bisect',horizontal_spacing:'8px',columns:[button('上一组',-1),button('下一组',1)]
      .map(element=>({tag:'column',width:'weighted',weight:1,elements:[element]}))},
    {tag:'markdown',text_size:'notation',content:'礼品与积分均为示例。试兑不扣积分。'},
  ];
  return card;
}

export async function navigatePointsStore(context, event, binding) {
  let value;
  try { value = typeof event.action_value === 'string' ? JSON.parse(event.action_value) : event.action_value; }
  catch { return {ignored:true,reason:'invalid_shop_page'}; }
  if (!binding.catalog || ![-1,1].includes(value?.step) || !Number.isInteger(value.revision)) {
    return {ignored:true,reason:'invalid_shop_page'};
  }
  if (!navigation.has(context)) navigation.set(context,new Map());
  const flights = navigation.get(context);
  const update = (flights.get(binding.messageId) ?? Promise.resolve()).catch(()=>{}).then(async()=>{
    const latest = await context.store.select(state=>state.checkinCards[binding.key]);
    if (latest.lastNavigationEvent === event.event_id) return {ok:true,duplicate:true};
    const page = latest.page + value.step;
    if (latest.pageRevision !== value.revision || page < 0 || page >= latest.catalog.pages.length) {
      return {ignored:true,reason:'stale_shop_page'};
    }
    const revision = latest.pageRevision+1;
    await context.feishu.updateCard(latest.messageId,pointsStorePageCard(latest.catalog,page,revision),{profile:latest.profile});
    await context.store.transact(state=>{
      const card=state.checkinCards[binding.key];
      Object.assign(card,{page,pageRevision:revision,lastNavigationEvent:event.event_id});
    });
    return {ok:true};
  });
  flights.set(binding.messageId,update);
  try { return await update; }
  finally { if (flights.get(binding.messageId)===update) flights.delete(binding.messageId); }
}
