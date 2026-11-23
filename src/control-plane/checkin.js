import { createHash } from 'node:crypto';
import { resolveProjectId } from '../shared/project-scope.js';
import { stateView } from '../shared/state-view.js';
import { adminUsage } from './admin-usage.js';

const openId = /^ou_[A-Za-z0-9]+$/;
const chatId = /^oc_[A-Za-z0-9]+$/;
const messageId = /^om_[A-Za-z0-9]+$/;
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

const checkinActions = new Set(['daily_checkin', 'my_checkin_points', 'points_store']);
export const isCheckinAction = (action) => checkinActions.has(action);

function actorKey(projects, {profile, senderId}) {
  const person = Object.entries(projects.humanIdentities ?? {})
    .find(([, identities]) => identities[profile] === senderId)?.[0];
  return JSON.stringify(person ? ['human', person] : ['actor', profile, senderId]);
}

function card(preview) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: preview ? 'AgentOS 每日签到 · 私聊体验' : 'AgentOS 每日签到' } },
    elements: [
      { tag: 'markdown', content: '每天签到一次，领取 **1 积分**。北京时间 00:00 开始新的一天。\n\n点击「查我的积分」，查看本周的签到和提问积分。结果由助手私聊发给你。' },
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

export async function publishCheckinCard(context, {profile, group} = {}) {
  const preview = group === undefined;
  const agent = assistant(context, profile);
  const owner = context.projects.humanIdentities?.groupOwner?.[profile];
  if (!agent || (preview ? !openId.test(owner ?? '') : !allowedGroup(context, agent, group))) {
    throw Object.assign(new Error('签到卡的机器人或目标群未登记'), { statusCode: 400 });
  }
  const target = preview ? owner : group;
  const key = preview ? hash('preview', profile, owner) : hash('group', group);
  const binding = await context.store.transact((state) => {
    state.checkinCards ??= {};
    const value = state.checkinCards[key] ??= { profile, preview, target };
    return { ...value };
  });
  if (binding.profile !== profile) throw Object.assign(new Error('该群已有另一助手发布的签到卡'), { statusCode: 409 });
  if (binding.messageId) return { messageId: binding.messageId, chatId: binding.chatId, preview, reused: true };
  const receipt = await send(context, profile, target, 'interactive', card(preview), key.slice(0, 32), preview ? 'open_id' : 'chat_id');
  if (!preview && receipt.chatId !== group) throw new Error('群签到卡回执与登记目标不一致');
  await context.store.transact((state) => { Object.assign(state.checkinCards[key], receipt); });
  return { ...receipt, preview };
}

function weekOf(day) {
  const start = new Date(day + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 1) % 7);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function handleCheckinAction(context, event, action, now = Date.now()) {
  if (!isCheckinAction(action)) return { ignored: true, reason: 'unknown_checkin_action' };
  const { operator_id: senderId, agent_profile: profile, chat_id: chat, message_id: message } = event;
  if (!openId.test(senderId) || !chatId.test(chat) || !messageId.test(message)) return { ignored: true, reason: 'invalid_checkin_actor' };
  const binding = await stateView(context.store, (s) => Object.values(s.checkinCards ?? {})
    .find((c) => c.profile === profile && c.messageId === message && c.chatId === chat));
  if (!binding || (binding.preview ? binding.target !== senderId : !allowedGroup(context, assistant(context, profile), chat))) {
    return { ignored: true, reason: 'checkin_card_scope_mismatch' };
  }
  const when = new Date(now).toISOString(), day = dayFormat.format(now);
  const actor = actorKey(context.projects, {profile, senderId});
  const ledger = binding.preview ? 'previewCheckins' : 'checkins';
  const id = hash(ledger, actor, day);
  const deliveryId = hash('checkin-receipt', profile, event.event_id, senderId, message, action);
  const result = await context.store.transact((state) => {
    state.checkinReceipts ??= {};
    if (state.checkinReceipts[deliveryId]) return { ...state.checkinReceipts[deliveryId] };
    if (action === 'points_store') {
      const receipt = { text: '积分商城，敬请期待。', day, sent: false };
      state.checkinReceipts[deliveryId] = receipt;
      return receipt;
    }
    state[ledger] ??= {};
    const prior = state[ledger][id];
    let text = prior ? '今天已签到。' : '今天还未签到。';
    if (action === 'daily_checkin') {
      state[ledger][id] ??= { id, chatId: chat, senderId, profile, day, createdAt: when, points: 1 };
      text = prior ? '今天已经签到。明天可以再领 1 积分。' : '签到成功，获得 1 积分。';
    }
    const week = weekOf(day);
    const signins = Object.values(state[ledger]).filter((row) => row.chatId === chat && row.day >= week.start
      && row.day <= week.end && actorKey(context.projects, row) === actor).length;
    const questions = binding.preview ? 0 : adminUsage({
      conversations: (state.conversations ?? []).filter((row) => actorKey(context.projects, row) === actor),
      questions: state.questions,
    }, { ...week, chatId: chat, excludeAdmin: 'false' }, { projects: context.projects }).summary.points;
    text += '\n本周 ' + (signins + questions) + ' 积分 · 签到 ' + signins + ' · 提问 ' + questions;
    if (binding.preview) text = '【私聊体验】' + text + '\n体验积分仅在这张卡里展示。';
    const receipt = { text, day, sent: false };
    state.checkinReceipts[deliveryId] = receipt;
    return { ...receipt };
  });
  if (result.sent) return { ok: true, duplicate: true };
  await send(context, profile, senderId, 'text', { text: result.text }, deliveryId.slice(0, 32));
  await context.store.transact((state) => {
    const receipts = state.checkinReceipts;
    receipts[deliveryId].sent = true;
    const cutoff = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    for (const [key, receipt] of Object.entries(receipts)) {
      if (receipt.sent && receipt.day < cutoff) delete receipts[key];
    }
  });
  return { ok: true, notification: 'callback_only' };
}
