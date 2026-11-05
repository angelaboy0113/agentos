import { createHash, randomInt } from 'node:crypto';
import { isAdministrator } from './authorization.js';
import { messageIdOf } from './live-cards.js';
import { reportEligible } from '../shared/report-acceptance.js';
import { stateView } from '../shared/state-view.js';

const effectId = value => 'aos-sticker-' + createHash('sha256').update(value).digest('hex').slice(0, 32);

export function stickerKey(content) {
  let value = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return typeof value?.file_key === 'string' && /^[A-Za-z0-9_-]+$/.test(value.file_key) ? value.file_key : null;
}

export class CompletionStickers {
  constructor(context) {
    this.context = context;
    this.profile = context.agents.agents?.owner_intake?.profile ?? null;
  }

  async receive(event, profile) {
    const { projects, store, feishu } = this.context;
    if (!this.profile || profile !== this.profile || event.chat_type !== 'p2p' ||
        event.sender_type !== 'user' || !event.message_id ||
        !isAdministrator(projects, { profile, senderId: event.sender_id })) return { ignored: true };
    const key = stickerKey(event.content) ?? await feishu.readStickerKey?.(event, { profile });
    if (!key) return { ignored: true, reason: 'sticker_key_unavailable' };
    const count = await store.transact(state => {
      state.completionStickers ??= {};
      const entry = state.completionStickers[profile] ??= { enabledAt: Date.now(), keys: [] };
      const library = entry.keys;
      if (!library.includes(key)) library.push(key);
      return library.length;
    });
    await feishu.reply(event.message_id, `原生表情包已登记，素材库现有 ${count} 张。`, {
      profile, idempotencyKey: effectId(event.message_id),
    });
    return { registered: true, count };
  }

  retry() {
    if (!this.profile || typeof this.context.feishu.replySticker !== 'function') return;
    this.pending ??= this.deliver().finally(() => { this.pending = null; });
    return this.pending;
  }

  async deliver() {
    const { store, feishu } = this.context;
    const keys = await stateView(store, state => state.completionStickers?.[this.profile]?.keys.length
      ? Object.keys(state.cardMessages ?? {}).filter(key => eligible(state, key, this.profile))
      : []);
    for (const key of keys) {
      const effect = await store.transact(state => {
        if (!eligible(state, key, this.profile)) return null;
        const card = state.cardMessages[key];
        const library = state.completionStickers[this.profile].keys;
        const prior = card.completionSticker;
        const fileKey = prior?.generation === card.generation ? prior.fileKey : library[randomInt(library.length)];
        card.completionSticker = { generation: card.generation, fileKey, retryAt: Date.now() + 30_000 };
        return { generation: card.generation, fileKey, destination: card.destination };
      });
      if (!effect) continue;
      try {
        const { destination, generation, fileKey } = effect;
        const result = await feishu.replySticker(destination.replyTo, fileKey, {
          profile: this.profile, replyInThread: destination.replyInThread, idempotencyKey: effectId(`${key}:${generation}`),
        });
        const id = messageIdOf(result);
        if (!id) throw new Error('Sticker delivery receipt missing');
        await store.transact(state => {
          const current = state.cardMessages[key]?.completionSticker;
          if (current?.generation === generation) current.messageId = id;
        });
      } catch {
        // The result and file are already delivered. Only this optional effect retries.
      }
    }
  }

  async close() { await this.pending; }
}

function eligible(state, key, profile) {
  const card = state.cardMessages?.[key];
  if (!card?.stickerEligible || !card.terminal || !card.messageId ||
      !card.mentionDelivered || card.revision !== card.deliveredRevision ||
      card.destination.profile !== profile || card.destination.visibility === 'requester' ||
      !card.destination.replyTo || !state.completionStickers?.[profile]?.keys.length) return false;
  const effect = card.completionSticker;
  if (effect?.generation === card.generation && (effect.messageId || effect.retryAt > Date.now())) return false;
  const question = state.questions?.[key.slice('question:'.length)];
  if (!question || question.generation !== card.stickerEligible ||
      !(Date.parse(question.createdAt) >= state.completionStickers[profile].enabledAt)) return false;
  const jobs = state.jobs.filter(job => job.questionId === question.id);
  const latest = jobs.at(-1);
  const file = jobs.flatMap(source => (source.reportFiles ?? []).filter(item =>
    item.questionGeneration === question.generation && reportEligible(latest?.reportReviews ? latest : source, item))).at(-1);
  return !file || Object.values(state.reportDeliveries ?? {}).some(delivery =>
    delivery.questionId === question.id && delivery.questionGeneration === question.generation &&
    delivery.item.id === file.id && delivery.messageId && !delivery.superseded);
}
