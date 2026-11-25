import { createHash } from 'node:crypto';
import { resolveProjectId } from '../shared/project-scope.js';
import { stateView } from '../shared/state-view.js';
import { adminUsage } from './admin-usage.js';
import { navigatePointsStore, pointsStorePageCard, pointsStorePages } from './points-store-pages.js';

const openId = /^ou_[A-Za-z0-9]+$/;
const chatId = /^oc_[A-Za-z0-9]+$/;
const messageId = /^om_[A-Za-z0-9]+$/;
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

const checkinActions = new Set(['daily_checkin', 'my_checkin_points', 'points_store','points_store_page']);
export const isCheckinAction = (action) => checkinActions.has(action);

function actorKey(projects, {profile, senderId}) {
  const person = Object.entries(projects.humanIdentities ?? {})
    .find(([, identities]) => identities[profile] === senderId)?.[0];
  return JSON.stringify(person ? ['human', person] : ['actor', profile, senderId]);
}

export function checkinCard(preview) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: preview ? 'AgentOS 每日签到 · 私聊体验' : 'AgentOS 每日签到' } },
    elements: [
      { tag: 'markdown', content: '每天签到一次，领取 **1 积分**。北京时间 00:00 开始新的一天。\n\n点击「查我的积分」，查看累计积分。结果由助手私聊发给你。' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '今日签到' }, type: 'primary', value: { action: 'daily_checkin' } },
        { tag: 'button', text: { tag: 'plain_text', content: '查我的积分' }, type: 'default', value: { action: 'my_checkin_points' } },
        { tag: 'button', text: { tag: 'plain_text', content: '积分商城' }, type: 'danger', value: { action: 'points_store' } },
      ] },
      ...(preview ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: '体验积分独立记录，正式积分和排行榜不受影响。' }] }] : []),
    ],
  };
}

function allowedGroup(context, agent, id) {
  return agent && chatId.test(id ?? '') && !context.projects.retiredChatIds?.includes(id)
    && (!agent.allowedChatIds || agent.allowedChatIds.includes(id))
    && resolveProjectId(context.projects, id, agent.profile);
}

function assistant(context, profile) {
  return Object.values(context.agents.agents ?? {}).find((a) => a.profile === profile && a.systemAssistant);
}

async function send(context, profile, receiveId, type, content, uuid, receiveIdType = 'open_id') {
  const receipt = await context.feishu.sendCheckinMessage({profile, receiveId, receiveIdType, type, content, uuid});
  if (!messageId.test(receipt.data?.message_id ?? '') || !chatId.test(receipt.data?.chat_id ?? '')) {
    throw new Error('签到消息未取得可核验的飞书回执');
  }
  return { messageId: receipt.data.message_id, chatId: receipt.data.chat_id };
}

function validPointsStorePreview(card) {
  if (card?.schema !== '2.0' || card.header?.title?.content !== 'AgentOS 积分商城'
    || !Array.isArray(card.body?.elements) || Buffer.byteLength(JSON.stringify(card)) > 28_000) return false;
  const nodes = [...card.body.elements];
  let buttons = 0;
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.tag === 'button') {
      if (node.disabled || !Array.isArray(node.behaviors) || node.behaviors.length !== 1 || node.behaviors[0]?.type !== 'callback'
        || node.behaviors[0].value?.action !== 'points_store') return false;
      buttons++;
    }
    nodes.push(...Object.values(node).filter(value => value && typeof value === 'object'));
  }
  return buttons > 0;
}

const reminderActions = [
  ['今日签到', 'daily_checkin'],
  ['查我的积分', 'my_checkin_points'],
  ['积分商城', 'points_store'],
];
const imageKey = /^img_[\w-]{1,160}$/;

function dailyReminderCard({posterKey, buttonKeys}) {
  return {schema:'2.0', config:{update_multi:true}, body:{
    direction:'vertical', padding:'12px', vertical_spacing:'10px', elements:[
      {tag:'markdown', content:'📅 **每日签到提醒**\n今天还没签到？点下方「今日签到」，领 1 积分。点「查我的积分」可看账号累计积分。'},
      {tag:'img', img_key:posterKey, alt:{tag:'plain_text',content:'AgentOS 每日签到海报'}, scale_type:'fit_horizontal', preview:true},
      {tag:'column_set', flex_mode:'trisect', horizontal_spacing:'8px', columns:reminderActions.map(([label,action],index)=>({
        tag:'column', width:'weighted', weight:1, elements:[{
          tag:'interactive_container', width:'fill', height:'auto', has_border:false, padding:'0px',
          behaviors:[{type:'callback',value:{action}}],
          elements:[{tag:'img', img_key:buttonKeys[index], alt:{tag:'plain_text',content:label}, scale_type:'fit_horizontal', preview:false}],
        }],
      }))},
      {tag:'markdown', text_align:'center', text_size:'notation', content:'<font color="grey">北京时间 00:00 开始新的一天。结果由助手私聊发送。</font>'},
    ],
  }};
}

export async function publishCheckinCard(context, {profile, group, previewRequestId, pointsStorePreviewCard, paginatePointsStore = false, groupReminder} = {}, now = Date.now()) {
  const preview = group === undefined;
  if (previewRequestId !== undefined && (!preview || typeof previewRequestId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(previewRequestId))) {
    throw Object.assign(new Error('新体验卡仅支持私聊，并须提供有效的请求编号'), { statusCode: 400 });
  }
  const shopPreview = pointsStorePreviewCard !== undefined;
  if (shopPreview && (!preview || !previewRequestId || !validPointsStorePreview(pointsStorePreviewCard))) {
    throw Object.assign(new Error('积分商城预览必须为仅含商城试兑按钮的私聊卡片'), { statusCode: 400 });
  }
  const catalog = paginatePointsStore && shopPreview ? pointsStorePages(pointsStorePreviewCard) : null;
  if (paginatePointsStore && !catalog) throw Object.assign(new Error('商城翻组预览至少需要两组双列礼品'),{statusCode:400});
  const agent = assistant(context, profile);
  const owner = context.projects.humanIdentities?.groupOwner?.[profile];
  if (!agent || (preview ? !openId.test(owner ?? '') : !allowedGroup(context, agent, group))) {
    throw Object.assign(new Error('签到卡的机器人或目标群未登记'), { statusCode: 400 });
  }
  if (groupReminder !== undefined && (preview || !groupReminder ||
    typeof groupReminder.posterKey !== 'string' || !imageKey.test(groupReminder.posterKey) ||
    !Array.isArray(groupReminder.buttonKeys) || groupReminder.buttonKeys.length !== reminderActions.length ||
    groupReminder.buttonKeys.some(key => typeof key !== 'string' || !imageKey.test(key)))) {
    throw Object.assign(new Error('签到提醒仅支持正式群及有效的海报、按钮素材'), {statusCode:400});
  }
  const reminderDay = groupReminder ? dayFormat.format(now) : null;
  const target = preview ? owner : group;
  const key = reminderDay ? hash('group-reminder', group, reminderDay) : previewRequestId === undefined
    ? (preview ? hash('preview', profile, owner) : hash('group', group))
    : hash(shopPreview ? 'points-store-preview' : 'preview-reissue', profile, owner, previewRequestId);
  const contentHash = groupReminder ? hash(groupReminder.posterKey, groupReminder.buttonKeys)
    : shopPreview ? (catalog ? hash('page',pointsStorePreviewCard) : hash(pointsStorePreviewCard)) : undefined;
  const binding = await context.store.transact((state) => {
    state.checkinCards ??= {};
    if (reminderDay) {
      const original = state.checkinCards[hash('group',group)];
      if (!original?.messageId || original.profile !== profile || original.chatId !== group) {
        throw Object.assign(new Error('此助手尚未在目标群发布正式签到卡'), {statusCode:409});
      }
    }
    const value = state.checkinCards[key] ??= { profile, preview, target,
      ...(shopPreview ? { purpose:'points_store', contentHash } : {}),
      ...(reminderDay ? {reminderDay, contentHash} : {}),
      ...(catalog ? {catalog,page:0,pageRevision:0} : {}),
    };
    return { ...value };
  });
  if (binding.profile !== profile) throw Object.assign(new Error('该群已有另一助手发布的签到卡'), { statusCode: 409 });
  if ((shopPreview || reminderDay) && binding.contentHash !== contentHash) {
    throw Object.assign(new Error('相同预览请求编号的卡片内容已变化'), { statusCode: 409 });
  }
  if (binding.messageId) return { messageId: binding.messageId, chatId: binding.chatId, preview, reused: true };
  const content = groupReminder ? dailyReminderCard(groupReminder)
    : catalog ? pointsStorePageCard(catalog) : pointsStorePreviewCard ?? checkinCard(preview);
  const receipt = await send(context, profile, target, 'interactive', content, key.slice(0, 32), preview ? 'open_id' : 'chat_id');
  if (!preview && receipt.chatId !== group) throw new Error('群签到卡回执与登记目标不一致');
  await context.store.transact((state) => { Object.assign(state.checkinCards[key], receipt); });
  return { ...receipt, preview };
}

const pendingMessage = {
  daily_checkin: '已收到签到，正在核对积分。',
  my_checkin_points: '正在查询积分，结果将私聊发给你。',
  points_store: '积分商城，敬请期待。',
};

export async function handleCheckinAction(context, event, action, now = Date.now()) {
  if (!isCheckinAction(action)) return { ignored: true, reason: 'unknown_checkin_action' };
  const { operator_id: senderId, agent_profile: profile, chat_id: chat, message_id: message } = event;
  if (!event.event_id || !openId.test(senderId) || !chatId.test(chat) || !messageId.test(message)) {
    return { ignored: true, reason: 'invalid_checkin_actor' };
  }
  const found = await stateView(context.store, (s) => Object.entries(s.checkinCards ?? {})
    .find(([,c]) => c.profile === profile && c.messageId === message && c.chatId === chat));
  const [key,binding] = found ?? [];
  if (!binding || (binding.preview ? binding.target !== senderId : !allowedGroup(context, assistant(context, profile), chat))) {
    return { ignored: true, reason: 'checkin_card_scope_mismatch' };
  }
  if (action === 'points_store_page') return navigatePointsStore(context,event,{...binding,key});
  if (binding.purpose === 'points_store' && action !== 'points_store') {
    return { ignored: true, reason: 'checkin_card_action_mismatch' };
  }
  const eventAt = Number(event.timestamp);
  const clickedAt = Number.isSafeInteger(eventAt) && eventAt >= 1e12 && eventAt <= now ? eventAt : now;
  const day = dayFormat.format(clickedAt);
  const deliveryId = hash('checkin-receipt', profile, event.event_id, senderId, message, action);
  const duplicate = await context.store.transact((state) => {
    state.checkinReceipts ??= {};
    const prior = state.checkinReceipts[deliveryId];
    if (prior) {
      if (!prior.sent && !prior.profile) Object.assign(prior, { profile, senderId });
      return true;
    }
    state.checkinReceipts[deliveryId] = {
      day, profile, senderId, chatId: chat, preview: binding.preview, action, createdAt: new Date(clickedAt).toISOString(), sent: false,
    };
    state.cardCallbackAudit ??= [];
    state.cardCallbackAudit.push({ at: new Date(now).toISOString(), profile, eventId: event.event_id,
      messageId: message, operatorId: senderId, action, cardContentPresent: !!event.card_content, outcome: 'accepted' });
    state.cardCallbackAudit = state.cardCallbackAudit.slice(-200);
    return false;
  });
  context.checkinQueue.wake();
  return { ok: true, duplicate, checkinQueued: true, message: pendingMessage[action], notification: 'callback_only' };
}

const directoryKey = ({profile, chatId, senderId}) => JSON.stringify([profile, chatId, senderId]);

async function lookupPointAccounts(context, state, receipt, proofs) {
  const accounts = new Set([actorKey(context.projects, receipt)]);
  if (receipt.preview || receipt.action === 'points_store' || !context.adminUsageDirectory || !context.feishu.getMessage) {
    return {accounts, incomplete: false};
  }
  const hints = await context.adminUsageDirectory.names({
    conversations: [...(state.conversations ?? []), receipt], checkins: state.checkins,
  });
  const name = hints.get(directoryKey(receipt));
  const candidates = new Map();
  for (const turn of state.conversations ?? []) {
    if (turn.profile === receipt.profile || turn.visibility === 'private' || turn.chatType === 'p2p' ||
        state.questions?.[turn.questionId]?.visibility === 'private' || !messageId.test(turn.messageId ?? '') ||
        !openId.test(turn.senderId ?? '') || !name || hints.get(directoryKey(turn)) !== name ||
        !allowedGroup(context, assistant(context, receipt.profile), turn.chatId) ||
        !allowedGroup(context, assistant(context, turn.profile), turn.chatId)) continue;
    const key = actorKey(context.projects, turn);
    const prior = candidates.get(key);
    if (!accounts.has(key) && (!prior || turn.createdAt > prior.createdAt)) candidates.set(key, turn);
  }
  let incomplete = !name;
  await Promise.all([...candidates].map(async ([account, turn]) => {
    const key = JSON.stringify([turn.profile, turn.chatId, turn.senderId, receipt.profile, receipt.senderId]);
    if (proofs.has(key)) {
      if (proofs.get(key)) accounts.add(account);
      return;
    }
    try {
      const [source, target] = await Promise.all([turn.profile, receipt.profile].map(profile =>
        context.feishu.getMessage(turn.messageId,{profile,timeoutMs:8000})));
      const matches = (message, senderId) => message?.message_id === turn.messageId &&
        message.chat_id === turn.chatId && !message.deleted &&
        message.sender?.sender_type === 'user' && message.sender.id_type === 'open_id' &&
        openId.test(senderId ?? '') && message.sender.id === senderId;
      if (!matches(source, turn.senderId) || !target || target.deleted) {
        incomplete = true;
      } else if (matches(target, target.sender?.id) && source.sender.tenant_key &&
          source.sender.tenant_key === target.sender.tenant_key) {
        const sameAccount = target.sender.id === receipt.senderId;
        proofs.set(key, sameAccount);
        if (sameAccount) accounts.add(account);
      } else {
        incomplete = true;
      }
    } catch {
      incomplete = true;
    }
  }));
  return {accounts, incomplete};
}

function settleReceipt(context, state, receipt, {accounts, incomplete}) {
  const { action, preview, profile, senderId, chatId, day, createdAt } = receipt;
  if (action === 'points_store') return pendingMessage.points_store;
  const actor = actorKey(context.projects, {profile, senderId});
  const ledger = preview ? 'previewCheckins' : 'checkins';
  const id = hash(ledger, actor, day);
  state[ledger] ??= {};
  const belongs = (row) => accounts.has(actorKey(context.projects, row));
  const prior = Object.values(state[ledger]).find(row => row.day === day && belongs(row));
  if (action === 'daily_checkin') {
    if (!prior) state[ledger][id] ??= { id, chatId, senderId, profile, day, createdAt, points: 1 };
  }
  const signins = new Set(Object.values(state[ledger]).filter(belongs).map(row => row.day)).size;
  const questions = preview ? 0 : adminUsage({
    conversations: (state.conversations ?? []).filter(belongs),
    questions: state.questions,
  }, { excludeAdmin: 'false' }, { projects: context.projects }).summary.points;
  const total = signins + questions;
  const caveat = incomplete ? '\n部分历史账号暂未核实。' : '';
  if (action === 'daily_checkin') {
    const [, month, date] = day.split('-').map(Number);
    return `${preview ? '【私聊体验】' : ''}${month}月${date}日获得 ${(prior ?? state[ledger][id]).points} 积分\n累计积分 ${total}${caveat}`;
  }
  const status = prior ? '今天已签到。' : '今天还未签到。';
  const text = `${status}\n累计 ${total} 积分 · 签到 ${signins} · 提问 ${questions}`;
  if (preview) return '【私聊体验】' + text + '\n体验积分单独累计。';
  return text + caveat + (state.retention && state.retention.mode !== 'archive' ? '\n提问积分按当前保留的历史记录统计。' : '');
}

export class CheckinQueue {
  constructor(context) {
    this.context = context;
    this.deliveries = new Map();
    this.accountProofs = new Map();
    this.closed = false;
  }

  start() {
    this.timer = setInterval(() => this.wake(), 3000);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.closed) return;
    this.wakeRequested = true;
    if (this.scheduled || this.processing) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.wakeRequested = false;
      this.processing = this.process().catch(() => console.error('[checkin] 积分处理暂缓，已保留回执'))
        .finally(() => {
          this.processing = null;
          if (this.wakeRequested) this.wake();
        });
    });
  }

  async process() {
    const { store } = this.context;
    const pending = await stateView(store, (state) => Object.entries(state.checkinReceipts ?? {})
      .filter(([id, receipt]) => !receipt.sent && receipt.profile && receipt.senderId && !this.deliveries.has(id)));
    const unsettled = pending.filter(([, receipt]) => !receipt.text);
    if (unsettled.length) {
      const state = await stateView(store, s => ({conversations:s.conversations, questions:s.questions, checkins:s.checkins}));
      const lookups = new Map();
      for (const [, receipt] of unsettled) {
        const key = JSON.stringify([receipt.preview, receipt.action === 'points_store', directoryKey(receipt)]);
        if (!lookups.has(key)) lookups.set(key, lookupPointAccounts(this.context,state,receipt,this.accountProofs));
      }
      const accounts = new Map(await Promise.all([...lookups].map(async ([key, lookup]) => [key, await lookup])));
      await store.transact((state) => {
        for (const [id, receipt] of unsettled) {
          const key = JSON.stringify([receipt.preview, receipt.action === 'points_store', directoryKey(receipt)]);
          state.checkinReceipts[id].text = settleReceipt(this.context, state, receipt, accounts.get(key));
        }
      });
    }
    const now = Date.now();
    const busyActors = new Set([...this.deliveries.values()].map(({ actor }) => actor));
    for (const [id, receipt] of pending) {
      if (this.closed || this.deliveries.size >= 4) break;
      const actor = actorKey(this.context.projects, receipt);
      if (busyActors.has(actor)) continue;
      busyActors.add(actor);
      if (receipt.retryAt > now) continue;
      const work = this.deliver(id).catch(() => console.error('[checkin] 私聊回执写入暂缓'))
        .finally(() => { this.deliveries.delete(id); this.wake(); });
      this.deliveries.set(id, { actor, work });
    }
  }

  async deliver(id) {
    const { store } = this.context;
    const receipt = await stateView(store, (state) => state.checkinReceipts[id]);
    let delivered = false;
    try {
      await send(this.context, receipt.profile, receipt.senderId, 'text', { text: receipt.text }, id.slice(0, 32));
      delivered = true;
    } catch {
      // Keep the same outbound UUID if delivery or its acknowledgment fails.
      console.warn('[checkin] 私聊投递暂缓，将重试');
    }
    await store.transact((state) => {
      const receipts = state.checkinReceipts;
      const current = receipts[id];
      if (delivered) {
        current.sent = true;
        delete current.retryAt;
        delete current.failures;
        const cutoff = dayFormat.format((current.createdAt ? Date.parse(current.createdAt) : Date.now()) - 7 * 86400000);
        for (const [key, old] of Object.entries(receipts)) {
          if (key !== id && old.sent && old.day < cutoff) delete receipts[key];
        }
      } else {
        current.failures = (current.failures ?? 0) + 1;
        current.retryAt = Date.now() + Math.min(60000, 3000 * 2 ** Math.min(current.failures - 1, 5));
      }
    });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearImmediate(this.scheduled);
    await this.processing;
    await Promise.all([...this.deliveries.values()].map(({work}) => work));
  }
}
