import path from 'node:path';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { runLarkCli } from './lark-cli.js';
import { reportFile } from '../shared/report-files.js';
import { reportEligible } from '../shared/report-acceptance.js';
import { prdDocumentTitle, prdIntentDigest } from '../shared/prd-workspace.js';
import { stateView } from '../shared/state-view.js';
import { questionJob, publishQuestion } from './questions.js';

const publishingScopes = 'docx:document docs:document.media:upload docs:permission.member:create docs:permission.member:read';
const validToken = /^[a-zA-Z0-9_-]{6,150}$/;
const hasNativeTable = xml => /<table(?:\s|>)/i.test(xml);
const authError = error => /no user logged in|app_scope_not_applied|user_scope_not_granted|missing_scope|missing required scope|99991672|99991679/i.test(error.message);

function documentIdentity(result) {
  const d = result.data ?? result;
  const token = d.document_id ?? d.doc_id ?? d.document_token ?? d.document?.document_id ?? d.document?.doc_id;
  if (!validToken.test(token ?? '')) throw Error('PRD_CREATE_UNVERIFIED');
  const url = new URL(d.url ?? d.doc_url ?? d.document?.url ?? d.document?.doc_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname)
    || url.pathname !== '/docx/' + token || url.search || url.hash) throw Error('PRD_DOCUMENT_URL');
  return { token, url: url.href };
}

export function prdMarkdown(body) {
  const text = body.trim();
  if (!/^#{1,3}\s+\S/m.test(text) || !/^\s*\|.+\|\s*$/m.test(text) || !/\*\*[^*]+\*\*/.test(text)
    || /<\/?[A-Za-z][^>]*>|!\[[^\]]*\]\(|(?:data|javascript):/i.test(text)) throw Error('PRD_NATIVE_BLOCK_CONTENT');
  return text;
}

export class PrdCloudDelivery {
  constructor(context, publisher, { cli = runLarkCli, onPublished, publishers = {} } = {}) {
    this.context = context;
    this.config = publisher;
    this.publishers = publishers;
    this.cli = cli;
    this.onPublished = onPublished;
    this.workers = new Map();
    this.closed = false;
    this.authorizationTimer = null;
  }

  publisherFor(q, revision) {
    const delivery = q.prd?.delivery?.revision === revision ? q.prd.delivery : null;
    const profile = delivery?.token ? delivery.publisherProfile ?? this.config?.profile : q.profile;
    const config = Object.hasOwn(this.publishers, profile) ? this.publishers[profile]
      : this.config?.profile === profile ? this.config : null;
    if (!config?.chatIds?.includes(q.chatId) || !/^ou_[A-Za-z0-9]+$/.test(config.ownerOpenId ?? '')) return null;
    return { ...config, profile };
  }

  wake(questionId) {
    if (this.workers.has(questionId) || this.closed) return;
    const task = this.deliver(questionId).catch(() => console.error('[prd-doc] delivery deferred'));
    this.workers.set(questionId, task);
    task.finally(() => this.workers.delete(questionId)).catch(() => {});
  }

  start() {
    this.recover().catch(() => {});
    this.authorizationTimer = setInterval(() => this.recover().catch(() => {}), 60_000);
    this.authorizationTimer.unref();
  }

  async recover() {
    const { ready, waiting } = await stateView(this.context.store, state => {
      const ready = [], waiting = new Map();
      for (const q of Object.values(state.questions ?? {})) {
        if (!q.prd || q.withdrawnAt) continue;
        const job = questionJob(state,q.id), phase = q.prd.delivery?.phase;
        if (job?.status !== 'completed' || job.result?.outcome !== 'ready' || job.prd?.exportRevision !== job.prd?.revision) continue;
        if (phase === 'authorization_required' && job.prd.auto) {
          const config = this.publisherFor(q, job.prd.revision);
          if (!config) continue;
          if (!waiting.has(config.profile)) waiting.set(config.profile,[]);
          waiting.get(config.profile).push(q.id);
        }
        if (['pending','created','body_verified','image_verified','shared',undefined].includes(phase)) ready.push(q.id);
      }
      return {ready,waiting};
    });
    for (const id of ready) this.wake(id);
    if (this.closed) return;
    await Promise.allSettled([...waiting].map(async ([profile, ids]) => {
      const scopes = await this.cli(['auth','check','--scope',publishingScopes],
        {profile,cliEntry:this.context.config.feishu?.cliEntry});
      if (scopes?.ok && !scopes.missing?.length) for (const id of ids) this.wake(id);
    }));
  }

  async close() {
    this.closed = true;
    clearInterval(this.authorizationTimer);
    await Promise.allSettled(this.workers.values());
  }

  async deliver(id) {
    const { store } = this.context;
    const snapshot = await stateView(store, state => {
      const q = state.questions[id], job = questionJob(state, id);
      if (!q?.prd || q.withdrawnAt || job?.status !== 'completed' || job.result?.outcome !== 'ready'
        || job.prd?.exportRevision !== job.prd?.revision) return null;
      return { q, job };
    });
    if (!snapshot) return;
    const { q, job } = snapshot, revision = job.prd.revision;
    const config = this.publisherFor(q, job.prd.revision);
    if (q.prd.delivery?.revision === revision && q.prd.delivery.sentAt) return;
    if (q.prd.delivery && q.prd.delivery.revision !== revision && !q.prd.delivery.sentAt) return;
    const files = ['md', 'png'].map(format => job.reportFiles?.findLast(file => file.format === format
      && file.questionGeneration === q.generation && reportEligible(job, file)));
    const digest = prdIntentDigest([id, q.chatId, revision, q.generation, ...files.map(f => f?.sha256)]);
    let delivery = q.prd.delivery?.revision === revision ? q.prd.delivery : { revision, digest, phase: 'pending' };
    if (delivery.digest !== digest) return;
    const save = async (phase, values = {}) => {
      const changed = await store.transact(state => {
        const fresh = state.questions[id];
        if (fresh?.withdrawnAt || fresh.generation !== q.generation || questionJob(state, id)?.prd?.revision !== revision) throw Error('PRD_SCOPE_CHANGED');
        const prior = fresh.prd.delivery;
        if (prior?.revision === revision && prior.digest !== digest) throw Error('PRD_ARTIFACT_CHANGED');
        fresh.prd.delivery = { ...delivery, ...values, phase, updatedAt: new Date().toISOString() };
        return fresh.prd.delivery;
      });
      delivery = changed;
    };
    try {
      if (['creating', 'inserting', 'sharing', 'unknown'].includes(delivery.phase)) return;
      if (!config) {
        await save('authorization_required', { notice: '已保留稿件，等待配置指定飞书账号与本群授权。' });
        return;
      }
      if (files.some(f => !f)) {
        await save('artifacts_missing', { notice: '需要已核验的 Markdown 和 PNG 原型。请在原话题补齐所缺的原型依据。' });
        return;
      }
      const dir = this.context.config.dataDir;
      const [{ content }, { file: image }] = await Promise.all(files.map((f, i) => reportFile(dir, job.id, f, { includeContent: i === 0 })));
      const markdown = prdMarkdown(content.toString('utf8'));
      const parent = path.join(dir, 'prd-delivery');
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(path.join(parent, 'export-'));
      try {
        const call = (args, extra = {}) => this.cli(args, { cwd, profile: config.profile, cliEntry: this.context.config.feishu?.cliEntry, ...extra });
        const user = await call(['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user', '--json']);
        if ((user.data?.open_id ?? user.open_id) !== config.ownerOpenId) {
          await save('authorization_required', { notice: '当前飞书用户身份与已登记的文档所有者不一致。' });
          return;
        }
        if (['pending', 'authorization_required', 'artifacts_missing'].includes(delivery.phase)) {
          const authorization = await call(['auth', 'check', '--scope', publishingScopes]).catch(error => {
            if (authError(error) || /"missing"\s*:\s*\[/.test(error.message)) return null;
            throw error;
          });
          if (!authorization?.ok || (authorization.missing?.length ?? 0) > 0) {
            await save('authorization_required', { notice: '已保留稿件。飞书账号尚未授权创建文档、上传图片及设置本群协作者。授权后会自动继续原卡交付。' });
            return;
          }
          await save('creating', { publisherProfile:config.profile });
          const created = await call(['docs', '+create', '--as', 'user', '--parent-position', 'my_library',
            '--doc-format', 'markdown', '--title', prdDocumentTitle(q, revision), '--content', '-'], { input: markdown, timeoutMs: 90_000 });
          await save('created', documentIdentity(created));
        }
        const doc = delivery.token;
        const render = async () => {
          const remote = await call(['docs', '+fetch', '--as', 'user', '--doc', doc, '--doc-format', 'xml', '--detail', 'full']);
          return JSON.stringify(remote).replaceAll('\\\"', '"');
        };
        if (delivery.phase === 'created') {
          const xml = await render();
          if (!hasNativeTable(xml) || !/<h[1-6](?:\s|>)/i.test(xml)) throw Error('PRD_NATIVE_BLOCK_READBACK');
          await save('body_verified');
        }
        if (delivery.phase === 'body_verified') {
          const filename = 'prototype.png';
          await copyFile(image, path.join(cwd, filename));
          await save('inserting');
          await call(['docs', '+media-insert', '--as', 'user', '--doc', doc, '--file', filename, '--type', 'image', '--caption', '需求原型图（评审用）']);
          const xml = await render();
          if (!/<(?:img|image)(?:\s|>)/i.test(xml)) throw Error('PRD_IMAGE_READBACK');
          await save('image_verified');
        }
        if (delivery.phase === 'image_verified') {
          await save('sharing');
          await call(['drive', '+member-add', '--as', 'user', '--token', doc, '--type', 'docx',
            '--member-type', 'openchat', '--member-id', q.chatId, '--perm', 'edit', '--yes']);
          await save('shared');
        }
        if (delivery.phase === 'shared') {
          const acl = await call(['drive', '+member-list', '--as', 'user', '--token', doc, '--type', 'docx']);
          const items = acl.data?.items ?? acl.data?.members ?? acl.items ?? [];
          if (!items.some(m => m.member_id === q.chatId && m.perm === 'edit' && m.member_type === 'openchat')) throw Error('PRD_ACL_READBACK');
          await save('delivered', { sentAt: new Date().toISOString(), notice: '飞书评审稿已创建，本群成员可编辑。' });
        }
      } finally { await rm(cwd, { recursive: true, force: true }); }
    } catch (error) {
      const code = String(error.message).match(/\b(PRD_[A-Z_]+|999[0-9]{5}|missing_scope|app_scope_not_applied|user_scope_not_granted)\b/)?.[0];
      if (code) console.error('[prd-doc]', id, delivery.phase, code);
      const authorization = authError(error);
      const uncertain = ['creating', 'inserting', 'sharing'].includes(delivery.phase);
      const phase = authorization && delivery.phase === 'creating' ? 'authorization_required' : uncertain ? 'unknown' : delivery.phase;
      await save(phase === 'pending' && authorization ? 'authorization_required' : phase, { notice: authorization
        ? '飞书用户身份或应用权限尚未接通，稿件已保留。授权后会自动继续原卡交付。'
        : '飞书文档或权限回读未完成，稿件已保留。请维护者核对记录后接续。' }).catch(() => {});
    } finally {
      await publishQuestion(this.context, id).catch(() => {});
      if (delivery.sentAt) await this.onPublished?.(id);
    }
  }
}
