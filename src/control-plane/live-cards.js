import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resultPages } from './result-presentation.js';

export function messageIdOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.message_id === 'string') return value.message_id;
  for (const child of Object.values(value)) { const id = messageIdOf(child); if (id) return id; }
  return null;
}

// Durable delivery outbox: a failed update NEVER reruns Codex or creates another task.
export class LiveCards {
  constructor(store, feishu, { intervalMs = 3000 } = {}) {
    this.store = store; this.feishu = feishu; this.intervalMs = intervalMs;
    this.workers = new Map(); this.closed = false;
    this.enabled = typeof feishu.replyCard === 'function' && typeof feishu.updateCard === 'function' && feishu.enabled !== false;
  }
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.retry().catch(() => {}), 1000); this.timer.unref();
  }
  async stop() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.workers.values()); }
  async upsert(key, card, destination, { terminal = false, immediate = false, resultText = '', terminalMention = null, generation = 0, guard } = {}) {
    if (Buffer.byteLength(JSON.stringify(card)) > 28_000) throw new Error('Card exceeds safe message limit');
    await this.store.transact((state) => {
      guard?.(state);
      state.cardMessages ??= {};
      const existing = state.cardMessages[key];
      if (generation && (!key.startsWith('question:') || !Number.isSafeInteger(generation) || generation < 1)) throw new Error('Invalid card generation');
      if ((existing?.generation ?? 0) > generation) return;
      const reopening = generation > (existing?.generation ?? 0);
      if (existing?.terminal && !terminal && !reopening) return; // Late progress cannot overwrite a conclusion.
      if (existing && JSON.stringify(existing.destination) !== JSON.stringify(destination)) throw new Error('Card identity cannot change');
      if (!reopening && existing?.terminalMention && terminalMention
        && JSON.stringify(existing.terminalMention) !== JSON.stringify(terminalMention)) throw new Error('Requester mention identity cannot change');
      state.cardMessages[key] = { ...existing, destination, card, terminal, generation, overflow: [],
        mentionDelivered: reopening ? false : existing?.mentionDelivered,
        terminalMention: (reopening ? null : existing?.terminalMention) ?? (terminal ? terminalMention : null),
        detailPages: resultPages(resultText),
        revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    });
    if (immediate) return this.flush(key, true);
    this.flush(key).catch(() => {});
  }
  async retry() {
    if (this.closed) return;
    const state = await this.store.read();
    for (const [key, value] of Object.entries(state.cardMessages ?? {})) {
      if ((value.revision !== value.deliveredRevision || (value.terminalMention && !value.mentionDelivered))
        && Date.now() >= (value.retryAt ?? 0)) this.flush(key).catch(() => {});
    }
  }
  async flush(key, force = false) {
    if (this.closed) return;
    if (this.workers.has(key)) {
      await this.workers.get(key);
      return force ? this.flush(key, true) : undefined;
    }
    const worker = this.deliver(key, force);
    this.workers.set(key, worker);
    try { return await worker; } finally { if (this.workers.get(key) === worker) this.workers.delete(key); }
  }
  async deliver(key, force) {
    const entry = (await this.store.read()).cardMessages?.[key];
    if (!entry || (entry.revision === entry.deliveredRevision && (!entry.terminalMention || entry.mentionDelivered))) return entry?.messageId;
    // A local maintenance hold prevents external edits while operator approval is pending.
    if (entry.messageId) {
      try {
        const heldIds = JSON.parse(await readFile(path.join(path.dirname(this.store.file), 'card-updates.paused'), 'utf8'));
        if (heldIds.includes(entry.messageId)) return entry.messageId;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!force && (Date.now() < (entry.retryAt ?? 0) || (!entry.terminal && Date.now() - (entry.sentAt ?? 0) < this.intervalMs))) return;
    try {
      const options = { replyInThread: entry.destination.replyInThread, profile: entry.destination.profile, idempotencyKey: `aos-card-${createHash('sha256').update(key).digest('hex').slice(0, 32)}` };
      let messageId = entry.messageId;
      if (messageId) {
        if (entry.revision !== entry.deliveredRevision) await this.feishu.updateCard(messageId, entry.card, options);
      }
      else {
        const result = entry.destination.replyTo
          ? await this.feishu.replyCard(entry.destination.replyTo, entry.card, options)
          : await this.feishu.sendCard(entry.destination.chatId, entry.card, options);
        messageId = messageIdOf(result);
        if (!messageId) throw new Error('Card send returned no message ID');
      }
      await this.store.transact((state) => {
        Object.assign(state.cardMessages[key], { messageId, deliveredRevision: entry.revision,
          sentAt: Date.now(), failures: 0, retryAt: 0 });
      });
      const fresh = await this.store.read(), latest = fresh.cardMessages[key];
      const question = key.startsWith('question:') ? fresh.questions?.[key.slice(9)] : null;
      const questionReady = !question || (question.generation <= entry.generation
        && !fresh.conversations.some((t) => t.questionId === question.id && ['queued', 'thinking', 'decided'].includes(t.status))
        && !fresh.jobs.some((j) => j.questionId === question.id && ['queued', 'running', 'cancelling', 'awaiting_approval', ...(entry.terminalMention?.kind==='browser_login'?[]:['awaiting_clarification']), ...(entry.terminalMention?.kind === 'environment_approval' ? [] : ['awaiting_environment_approval'])].includes(j.status)));
      if (entry.terminalMention && !entry.mentionDelivered && latest.revision === entry.revision && questionReady) {
        await this.feishu.reply(entry.terminalMention.replyTo, entry.terminalMention.text, {
          profile: entry.terminalMention.profile, replyInThread: entry.terminalMention.replyInThread ?? entry.destination.replyInThread,
          idempotencyKey: `aos-mention-${createHash('sha256').update(entry.generation ? `${key}:${entry.generation}` : key).digest('hex').slice(0, 32)}`,
        });
        await this.store.transact((state) => {
          if (state.cardMessages[key].generation === entry.generation) Object.assign(state.cardMessages[key], { mentionDelivered: true, failures: 0, retryAt: 0 });
        });
      }
      // Long reports stay in the same card. Never resume legacy plaintext overflow on restart.
      return messageId;
    } catch (error) {
      await this.store.transact((state) => {
        const current = state.cardMessages[key]; current.failures = (current.failures ?? 0) + 1;
        current.retryAt = Date.now() + Math.min(60_000, current.failures * 5000);
        current.error = '消息投递失败，等待重试'; // Never persist raw CLI credentials in public status.
      });
      throw error;
    }
  }
}
