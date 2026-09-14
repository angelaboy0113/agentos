import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId } from '../shared/protocol.js';

const OPEN_API = 'https://open.feishu.cn/open-apis';

export class FeishuClient {
  constructor({ appId, appSecret, dataDir }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.dataDir = dataDir;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.appId && this.appSecret);
  }

  async tenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(`Feishu token request failed: ${body.msg ?? response.status}`);
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(body.expire ?? 7200) - 120) * 1000;
    return this.token;
  }

  async reply(messageId, text) {
    if (!this.enabled || !messageId) return;
    const token = await this.tenantToken();
    const response = await fetch(`${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
    });
    if (!response.ok) throw new Error(`Feishu reply failed: HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 0) throw new Error(`Feishu reply failed: ${result.code}`);
    return result;
  }

  async replyCard(messageId, card, options = {}) {
    return this.cardRequest('POST', `/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { msg_type: 'interactive', content: JSON.stringify(card), uuid: options.idempotencyKey });
  }
  async sendCard(chatId, card, options = {}) {
    return this.cardRequest('POST', '/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: options.idempotencyKey });
  }
  async updateCard(messageId, card) {
    return this.cardRequest('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) });
  }
  async cardRequest(method, route, body) {
    const token = await this.tenantToken();
    const response = await fetch(`${OPEN_API}${route}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(`Feishu card failed: ${result.code ?? response.status}`);
    return result;
  }

  async downloadMessageResource(jobId, messageId, resourceKey, type = 'image') {
    if (!this.enabled) return null;
    const token = await this.tenantToken();
    const url = `${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(type)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Feishu resource download failed: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const extension = extensionFor(contentType, type);
    const directory = path.join(this.dataDir, 'attachments', jobId);
    await mkdir(directory, { recursive: true });
    const id = createId('ATT');
    const file = path.join(directory, `${id}${extension}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    return { id, type, contentType, path: file, originalResourceKey: resourceKey };
  }
}

export function parseFeishuMessage(message) {
  const raw = safeJson(message.content);
  const mentions = message.mentions ?? [];
  let text = '';
  const resources = [];

  if (message.message_type === 'text') text = raw.text ?? '';
  if (message.message_type === 'image' && raw.image_key) resources.push({ key: raw.image_key, type: 'image' });
  if (message.message_type === 'file' && raw.file_key) resources.push({ key: raw.file_key, type: 'file' });
  if (message.message_type === 'post') {
    for (const locale of Object.values(raw)) {
      if (!locale || typeof locale !== 'object') continue;
      if (locale.title) text += `${locale.title} `;
      for (const paragraph of locale.content ?? []) {
        for (const item of paragraph) {
          if (item.tag === 'text' || item.tag === 'a') text += `${item.text ?? ''} `;
          if (item.tag === 'img' && item.image_key) resources.push({ key: item.image_key, type: 'image' });
        }
      }
    }
  }
  for (const mention of mentions) {
    if (mention.key) text = text.replaceAll(mention.key, '');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), resources };
}

function safeJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? {}); }
  catch { return {}; }
}

function extensionFor(contentType, type) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  return type === 'image' ? '.img' : '.bin';
}
