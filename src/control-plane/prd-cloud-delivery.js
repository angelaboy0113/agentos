import path from 'node:path';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { runLarkCli } from './lark-cli.js';
import { reportFile } from '../shared/report-files.js';
import { readPrdDesignReference } from '../shared/image-generation.js';
import { previousPrdDelivery, prdHighlightChanges, readPrdRevisionBaseline } from '../shared/prd-revision.js';
import { reportEligible } from '../shared/report-acceptance.js';
import { prdBusinessAligned, prdDocumentTitle, prdFinalContentIssue, prdIntentDigest, prdReviewBasisMissing } from '../shared/prd-workspace.js';
import { stateView } from '../shared/state-view.js';
import { currentUserQuestion } from '../shared/user-request-scope.js';
import { questionJob, publishQuestion } from './questions.js';

const publishingScopes = 'docx:document docs:document.media:upload docs:permission.member:create docs:permission.member:retrieve';
const validToken = /^[a-zA-Z0-9_-]{6,150}$/;
const hasMarkdownTable = body => /^\s*\|.+\|\s*$/m.test(body);
const hasNativeTable = xml => /<table(?:\s|>)/i.test(xml);
const authError = error => /no user logged in|app_scope_not_applied|user_scope_not_granted|missing_scope|missing required scope|99991672|99991679/i.test(error.message);
const prototypeAnchors = body => [...body.matchAll(/^\[\[PROTOTYPE:([a-z][a-z0-9-]{0,63})\]\][ \t]*$/gm)].map(match => match[1]);
const marker = key => 'AGENTOSPRDFIGURE-'+key;
const paragraph = block => block?.text?.elements?.map(e => e.text_run?.content ?? '').join('').trim();

function reviewedPrdMarkdown(job, generation) {
  const { handoffGate, reportAssessment, reportInspections } = job.result;
  if (!handoffGate?.passed || reportAssessment?.decision !== 'deliver' || reportAssessment.coverage !== 'complete'
    || reportAssessment.issues?.length) return null;
  const selected = reportAssessment.deliverables ?? [];
  return job.reportFiles?.findLast(file => file.format === 'md' && (file.sourceJobId ?? job.id) === job.id
    && Number.isSafeInteger(file.questionGeneration) && file.questionGeneration < generation && reportEligible(job,file)
    && selected.some(item=>item.fileId===file.id && item.evidence?.trim())
    && reportInspections?.some(item=>item.status==='verified' && item.contentAudit?.structure==='passed'
      && item.binding?.sourceJobId===job.id && item.binding.fileId===file.id && item.binding.sha256===file.sha256
      && item.binding.verificationHash===file.verificationHash));
}

async function documentChildren(call, doc) {
  const items = [];
  let pageToken;
  do {
    const result = await call(['api','GET',`/open-apis/docx/v1/documents/${doc}/blocks/${doc}/children`,
      '--as','user','--params',JSON.stringify({page_size:100, ...(pageToken ? {page_token:pageToken} : {})})]);
    if (!Array.isArray(result.data?.items)) throw Error('PRD_IMAGE_READBACK');
    items.push(...result.data.items);
    const next = result.data.has_more ? result.data.page_token : undefined;
    if (result.data.has_more && (!next || next === pageToken)) throw Error('PRD_IMAGE_READBACK');
    pageToken = next;
  } while (pageToken);
  return items;
}

async function insertInlineImages(call, cwd, doc, figures) {
  let blocks = await documentChildren(call, doc);
  for (const { key, artifact: { file } } of figures) {
    const anchors = blocks.filter(block => paragraph(block) === marker(key));
    if (anchors.length !== 1 || !validToken.test(anchors[0].block_id)) throw Error('PRD_IMAGE_ANCHOR');
    const anchor = anchors[0].block_id;
    const filename = 'prototype.png';
    await copyFile(file, path.join(cwd, filename));
    await call(['docs','+media-insert','--as','user','--doc',doc,'--file',filename,'--type','image']);
    const existing = new Set(blocks.map(b => b.block_id));
    blocks = await documentChildren(call, doc);
    const images = blocks.filter(b => !existing.has(b.block_id) && b.block_type === 27 && b.image?.token);
    if (images.length !== 1 || !validToken.test(images[0].block_id)) throw Error('PRD_IMAGE_READBACK');
    const image = images[0].block_id;
    const insertedAt = blocks.findIndex(b => b.block_id === anchor);
    if (insertedAt < 0) throw Error('PRD_IMAGE_ANCHOR');
    if (blocks[insertedAt+1]?.block_id !== image) {
      await call(['docs','+update','--as','user','--doc',doc,'--command','block_move_after','--block-id',anchor,'--src-block-ids',image]);
      blocks = await documentChildren(call, doc);
    }
    const index = blocks.findIndex(b => b.block_id === anchor);
    if (index < 0 || blocks[index+1]?.block_type !== 27 || blocks[index+1]?.image?.token !== images[0].image.token) {
      throw Error('PRD_IMAGE_POSITION');
    }
    await call(['docs','+update','--as','user','--doc',doc,'--command','str_replace','--pattern',marker(key),
      '--doc-format','markdown','--content','界面原型（拟议）']);
    blocks = await documentChildren(call, doc);
    if (blocks[index+1]?.image?.token !== images[0].image.token || paragraph(blocks[index]) !== '界面原型（拟议）'
      || blocks.some(b => paragraph(b) === marker(key))) {
      throw Error('PRD_IMAGE_POSITION');
    }
  }
}

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

export function prdMarkdown(body, { prototypeHash, referenceHashes = [], tableRequired = true } = {}) {
  const references = new Set(referenceHashes);
  const text = body.replace(/!\[[^\]\r\n]*\]\(data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})\)/gi,
    (markup, base64) => {
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) return markup;
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash === prototypeHash) return '（新原型见文末）';
      if (references.has(hash)) return '（初稿图片作为设计参考）';
      return markup;
    }).trim();
  if (!/^#{1,3}\s+\S/m.test(text) || (tableRequired && !hasMarkdownTable(text)) || !/\*\*[^*]+\*\*/.test(text)
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
    const prior = q.prd?.delivery;
    const delivery = prior?.revision === revision ? prior : null;
    const profile = delivery?.token ? delivery.publisherProfile ?? this.config?.profile : q.profile;
    const config = Object.hasOwn(this.publishers, profile) ? this.publishers[profile]
      : this.config?.profile === profile ? this.config : null;
    if (!config?.chatIds?.includes(q.chatId) || !/^ou_[A-Za-z0-9]+$/.test(config.ownerOpenId ?? '')) return null;
    return { ...config, profile };
  }

  async readDraftMembers({ profile, chatId }, token) {
    const publisher = this.publisherFor({ profile, chatId });
    if (!publisher || !validToken.test(token)) throw Error('PRD_DRAFT_OWNER_NOT_CONFIGURED');
    const options = { profile: publisher.profile, cliEntry: this.context.config.feishu?.cliEntry };
    const user = await this.cli(['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user', '--json'], options);
    if ((user.data?.open_id ?? user.open_id) !== publisher.ownerOpenId) throw Error('PRD_DRAFT_OWNER_MISMATCH');
    const acl = await this.cli(['drive', '+member-list', '--as', 'user', '--type', 'docx', '--token', token, '--json'], options);
    return acl.data;
  }

  wake(questionId) {
    if (this.workers.has(questionId) || this.closed) return;
    const task = this.deliver(questionId).catch(() => console.error('[prd-doc] delivery deferred'));
    this.workers.set(questionId, task);
    task.finally(() => this.workers.delete(questionId)).catch(() => {});
  }

  start() {
    this.recover({ recheckArtifacts: true }).catch(() => {});
    this.authorizationTimer = setInterval(() => this.recover().catch(() => {}), 60_000);
    this.authorizationTimer.unref();
  }

  async recover({ recheckArtifacts = false } = {}) {
    const { ready, waiting } = await stateView(this.context.store, state => {
      const ready = [], waiting = new Map();
      for (const q of Object.values(state.questions ?? {})) {
        if (!q.prd || q.withdrawnAt) continue;
        const job = questionJob(state,q.id);
        const phase = q.prd.delivery?.revision === job?.prd?.revision ? q.prd.delivery?.phase : undefined;
        if (job?.status !== 'completed' || job.result?.outcome !== 'ready' || job.prd?.exportRevision !== job.prd?.revision) continue;
        if (phase === 'authorization_required' && job.prd.auto) {
          const config = this.publisherFor(q, job.prd.revision);
          if (!config) continue;
          if (!waiting.has(config.profile)) waiting.set(config.profile,[]);
          waiting.get(config.profile).push(q.id);
        }
        if (['pending','created','body_verified','image_verified','shared',undefined].includes(phase)
          || recheckArtifacts && phase === 'artifacts_missing') ready.push(q.id);
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
    const inline = job.prd.inlinePrototypes === true;
    const eligible = (job.reportFiles ?? []).filter(file => file.questionGeneration === q.generation && reportEligible(job, file));
    const prototypes = eligible.filter(f => f.format === 'png');
    const currentMarkdown = eligible.findLast(f => f.format === 'md');
    const reviewedMarkdown = inline && !currentMarkdown ? reviewedPrdMarkdown(job,q.generation) : null;
    const files = [currentMarkdown ?? reviewedMarkdown, ...(inline ? prototypes : [prototypes.at(-1)])];
    const previous = previousPrdDelivery(q, revision);
    const digest = prdIntentDigest([id, q.chatId, revision, q.generation, ...files.map(f => f?.sha256)]);
    let delivery = q.prd.delivery?.revision === revision ? q.prd.delivery : { revision, digest, phase: 'pending' };
    // Rebind only the pre-creation record from a missing current draft. Once
    // cloud creation starts, the original digest remains a hard guard.
    const missingBodyDigest = prdIntentDigest([id,q.chatId,revision,q.generation,undefined,...prototypes.map(f=>f.sha256)]);
    const mayRebind = prior => reviewedMarkdown && prior?.phase === 'artifacts_missing' && !prior.token
      && prior.digest === missingBodyDigest;
    if (delivery.digest !== digest && !mayRebind(delivery)) return;
    const save = async (phase, values = {}) => {
      const changed = await store.transact(state => {
        const fresh = state.questions[id];
        if (fresh?.withdrawnAt || fresh.generation !== q.generation || questionJob(state, id)?.prd?.revision !== revision) throw Error('PRD_SCOPE_CHANGED');
        const prior = fresh.prd.delivery;
        if (prior?.revision === revision && prior.digest !== digest && !mayRebind(prior)) throw Error('PRD_ARTIFACT_CHANGED');
        if (prior?.sentAt && prior.revision !== revision) {
          fresh.prd.deliveryHistory ??= {};
          fresh.prd.deliveryHistory[prior.revision] = prior;
        }
        fresh.prd.delivery = { ...delivery, ...values, digest, phase, updatedAt: new Date().toISOString() };
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
      if (!prdBusinessAligned(job, job.result)) {
        await save('artifacts_missing', { notice: '业务口径尚未确认齐全，本轮未发布。请在当前卡片补充已确认的规则。' });
        return;
      }
      if (prdReviewBasisMissing(job, job.result).length) {
        await save('artifacts_missing', { notice: '需求背景、模块影响或页面依据尚未核验齐全，本轮未发布。' });
        return;
      }
      if ((!job.prd.fixedFinalSections && files.length < 2) || files.some(f => !f)) {
        await save('artifacts_missing', { notice: '完整交付仍缺少已核验的正文或原型图。如需补充原型依据，可填写这张需求卡。' });
        return;
      }
      const dir = this.context.config.dataDir;
      const [{ content }, ...images] = await Promise.all(files.map((f, i) =>
        reportFile(dir, job.id, f, { includeContent: i === 0, includeReceipt: i > 0 })));
      const raw = content.toString('utf8');
      const issue = job.prd.businessFinal && prdFinalContentIssue(raw, job.prd.fixedFinalSections);
      if (issue) {
        await save('artifacts_missing', { notice: issue });
        return;
      }
      const keys = inline ? prototypeAnchors(raw) : [null];
      if ((!keys.length && (!job.prd.fixedFinalSections || images.length)) || new Set(keys).size !== keys.length || (inline && (raw.match(/\[\[PROTOTYPE:/g)?.length ?? 0) !== keys.length)) {
        await save('artifacts_missing', { notice: '正文原型位置缺失或重复。请为每张图设置唯一的对应章节。' });
        return;
      }
      const requestHash = createHash('sha256').update(String(currentUserQuestion(job))).digest('hex');
      // A login resume advances the card generation without advancing the PRD
      // revision. Files are still selected by the current card generation.
      const matchesGeneration = (binding, legacyNull = false) => binding?.generation === q.generation
        || (binding?.questionHash === requestHash && (
          (job.questionGeneration === undefined && binding.generation === revision && revision < q.generation)
          || (legacyNull && binding.generation === null && revision === q.generation)
        ));
      const figures = [];
      for (const key of keys) {
        const index = inline ? images.findLastIndex(a => a.receipt.request?.imageGeneration?.prototypeKey === key) : 0;
        const artifact = images[index];
        const provenance = artifact?.receipt.request?.imageGeneration;
        const reference = await readPrdDesignReference(dir, job, provenance?.referenceId);
        const imageEdit = provenance?.proposedImage;
        const providerVerified = inline && job.prd.nativePrototypeEdits
          ? provenance?.provider === 'prd-native-image-edit' && imageEdit?.provider === 'codex-native'
            && imageEdit.status === 'verified' && imageEdit.inputHashes?.[0] === reference?.sha256
            && imageEdit.referenceKinds?.[0] === 'website-design-reference'
            && imageEdit.binding?.jobId === job.id && imageEdit.binding?.questionId === id
            && imageEdit.binding?.projectId === q.projectId && imageEdit.binding?.profile === q.profile
            && imageEdit.binding?.environment === job.sourceEnvironment && matchesGeneration(imageEdit.binding)
          : inline ? provenance?.provider === 'prd-screenshot-composite'
            : ['codex-native','prd-screenshot-composite'].includes(provenance?.provider);
        if (!reference || provenance?.status !== 'verified' || !providerVerified
          || provenance.sha256 !== files[index+1]?.sha256 || provenance.inputHashes?.[0] !== reference.sha256
          || provenance.referenceKinds?.[0] !== 'website-design-reference'
          || provenance.binding?.jobId !== job.id || provenance.binding?.questionId !== id
          || provenance.binding?.projectId !== q.projectId || provenance.binding?.profile !== q.profile
          || provenance.binding?.environment !== job.sourceEnvironment || !matchesGeneration(provenance.binding, true)) {
          await save('artifacts_missing', { notice: '原型缺少本轮真实目标页面截图的生成凭据。请先取得对应系统和环境的截图，再重做原型。' });
          return;
        }
        figures.push({ key, artifact });
      }
      const referenceHashes = (job.attachments ?? []).filter(a => a.source?.kind === 'authorized-prd-document-image'
        && a.source.questionId === id && a.source.originProfile === q.profile && a.source.projectId === q.projectId)
        .map(a => a.source.sha256);
      const baseline = previous ? await readPrdRevisionBaseline(dir, job, previous).catch(() => null) : null;
      const body = prdMarkdown(raw, { prototypeHash: files[1]?.sha256, referenceHashes, tableRequired: !job.prd.fixedFinalSections });
      const highlighted = prdHighlightChanges(baseline, body);
      const markdown = inline ? highlighted.replace(/^\[\[PROTOTYPE:([a-z][a-z0-9-]{0,63})\]\][ \t]*$/gm, (_, key) => marker(key)) : highlighted;
      const hasHighlights = markdown.includes('<span background-color=');
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
          await save('creating', { publisherProfile:config.profile, inlineHighlights:hasHighlights });
          const created = await call(['docs', '+create', '--as', 'user', '--parent-position', 'my_library',
            '--doc-format', 'markdown', '--title', prdDocumentTitle(q, revision, job.prd.businessFinal), '--content', '-'], { input: markdown, timeoutMs: 90_000 });
          await save('created', documentIdentity(created));
        }
        const doc = delivery.token;
        const render = async () => {
          const remote = await call(['docs', '+fetch', '--as', 'user', '--doc', doc, '--doc-format', 'xml', '--detail', 'full']);
          return JSON.stringify(remote).replaceAll('\\\"', '"');
        };
        if (delivery.phase === 'created') {
          const xml = await render();
          if ((!job.prd.fixedFinalSections || hasMarkdownTable(body)) && !hasNativeTable(xml) || !/<h[1-6](?:\s|>)/i.test(xml) || hasHighlights && !/<span[^>]*background-color="(?:(?:light-)?yellow|rgba\(255,\s*246,\s*122,\s*0\.8\))"/i.test(xml) && !(delivery.inlineHighlights === undefined && xml.includes('本次变更'))) throw Error('PRD_NATIVE_BLOCK_READBACK');
          await save('body_verified');
        }
        if (delivery.phase === 'body_verified' && !figures.length) await save('image_verified');
        if (delivery.phase === 'body_verified') {
          await save('inserting');
          if (inline) {
            await insertInlineImages(call, cwd, doc, figures);
          } else {
            const filename = 'prototype.png';
            await copyFile(figures[0].artifact.file, path.join(cwd, filename));
            await call(['docs', '+media-insert', '--as', 'user', '--doc', doc, '--file', filename, '--type', 'image', '--caption', '需求原型图（评审用）']);
          }
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
          await save('delivered', { sentAt: new Date().toISOString(), notice: '飞书评审稿已创建，本群成员可编辑。',
            artifacts:{ generation:q.generation, markdownId:files[0].id,
              ...(reviewedMarkdown ? { markdownGeneration:reviewedMarkdown.questionGeneration } : {}),
              ...(inline ? { prototypeIds:files.slice(1).map(f => f.id) } : { prototypeId:files[1].id }) } });
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
