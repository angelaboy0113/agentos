import { parseWebsiteCredentialMessage, stripCredentialMentions } from './website-credentials.js';
import { saveKeychainCredential } from '../shared/keychain-credential.js';
import { resolveProjectId } from '../shared/project-scope.js';
import { launchEnrollment } from './environment-enrollment.js';
import { createId } from '../shared/protocol.js';
import { isAdministrator } from './authorization.js';

// Consume secrets before conversation/model/history ingestion. Only the local Keychain receives values.
export class EnrollmentCredentialService {
  constructor(context, adapters = {}) { this.context = context; this.save = adapters.save ?? saveKeychainCredential; this.launch = adapters.launch ?? launchEnrollment; }
  async handle(event) {
    const text = stripCredentialMentions(event.content, event.mentions);
    const shared = text.match(/账号(?:和|、|及)?密码(?:都)?(?:是|为|[:：=])\s*[:：=]?\s*([^\s，。；]+)\s*[。！!]?$/);
    const explicit = shared ? { username: shared[1], password: shared[1] } : parseWebsiteCredentialMessage(text);
    const state = await this.context.store.read();
    const profile = event.agent_profile ?? null;
    const projectId = resolveProjectId(this.context.projects, event.chat_id, profile);
    const pending = Object.values(state.environmentEnrollments ?? {}).filter(e => e.kind === 'nacos'
      && (['requested', 'opening', 'login_required'].includes(e.status) || e.status === 'failed' && !e.retriedBy && e.approver?.profile === profile) && e.profile === profile
      && e.chatId === event.chat_id && e.projectId === projectId);
    const ids = [event.reply_to, event.root_id, event.thread_id].filter(Boolean);
    const related = pending.filter(e => {
      const q = state.questions?.[e.questionId];
      const card = state.cardMessages?.[`question:${e.questionId}`];
      return [q?.messageId, q?.threadRootId, card?.messageId].some(id => id && ids.includes(id));
    });
    const websiteReply = (state.jobs ?? []).some(job => job.status === 'awaiting_clarification'
      && job.result?.browserLoginRequired && job.environmentAccess?.kind === 'website'
      && job.chatId === event.chat_id && [state.questions?.[job.questionId]?.messageId,
        state.questions?.[job.questionId]?.threadRootId,
        state.cardMessages?.[`question:${job.questionId}`]?.messageId].some(id => id && ids.includes(id)));
    if (!related.length && websiteReply) return null;
    const parsed = explicit ?? (related.length === 1 ? parseWebsiteCredentialMessage(text, { allowLoose: true }) : null);
    if (!parsed || !pending.length) return null;
    const reply = async notice => {
      await this.context.feishu.reply(event.message_id ?? event.id, notice, { profile, replyInThread: true });
      return { credentialMessage: true };
    };
    if (!isAdministrator(this.context.projects, { profile, senderId: event.sender_id })) return reply('Nacos 接入凭据仅群主可以提供，未保存或使用。');
    const urls = [...text.matchAll(/https?:\/\/[^\s\u3000-\u9fff，。；]+/g)].map(m => {
      try { const u = new URL(m[0]); if (u.username || u.password || u.search) return null; return u.origin + u.pathname.replace(/\/$/, ''); } catch { return null; }
    });
    if (urls.some(u => !u) || new Set(urls).size > 1) return reply('请一次提供一个待接入 Nacos 的凭据，并回复对应话题；本次未保存或登录。');
    let candidates = related.length ? related : pending;
    if (urls.length) candidates = candidates.filter(e => e.url === urls[0]);
    if (!related.length && !urls.length || candidates.length !== 1) return reply('请直接回复对应 Nacos 接入卡片或话题，或带上唯一入口地址，避免登录错误环境。');
    if (parsed.invalid || !parsed.username || !parsed.password) return reply('请回复“账号：你的账号 密码：你的密码”，或“账号密码都是：相同值”。本次未保存不完整凭据。');
    const previous = candidates[0];
    const retry = previous.status === 'failed';
    if (retry && Object.values(state.environmentEnrollments ?? {}).some(e => ['opening','login_required'].includes(e.status))) return reply('本机已有接入窗口，请先完成当前接入；本次未保存或启动另一个窗口。');
    const e = retry ? { ...previous, id: createId('ENR'), status: 'opening', createdAt: new Date().toISOString(),
      approver: { profile, senderId: event.sender_id }, retryOf: previous.id } : previous;
    if (previous.credentialReceiptMessageId === event.message_id) return { credentialMessage: true };
    try { await this.save(e.id.toLowerCase(), { username: parsed.username, password: parsed.password }); }
    catch { return reply('本机钥匙串保存未完成，请解锁运行电脑的登录钥匙串后重试；未把凭据交给模型。'); }
    const accepted = await this.context.store.transact(s => {
      const source = s.environmentEnrollments?.[previous.id];
      if (!source || !(retry ? source.status === 'failed' : ['requested','opening','login_required'].includes(source.status)) || source.url !== e.url || source.profile !== profile) return false;
      if (retry) {
        if (Object.values(s.environmentEnrollments).some(x => ['opening','login_required'].includes(x.status))) return false;
        s.environmentEnrollments[e.id] = { ...e };
        delete s.environmentEnrollments[e.id].diagnostic;
        source.retriedBy = e.id;
      }
      const current = s.environmentEnrollments[e.id];
      current.credentialReceiptMessageId = event.message_id;
      current.credentialReceivedAt = new Date().toISOString();
      if (s.questions?.[current.questionId]) s.questions[current.questionId].generation++;
      return true;
    });
    if (!accepted) return reply('该接入申请已发生变化，未启动其他目标的登录。请回复当前有效接入卡片。');
    if (retry) {
      try { await this.launch(this.context, e); }
      catch { await this.context.store.transact(s => { s.environmentEnrollments[e.id].status = 'failed'; }); return reply('凭据已在本机保存，但独立登录窗口启动失败，请检查运行电脑的桌面会话后重试。'); }
    }
    if (this.context.cards) {
      try { const {publishQuestion}=await import('./questions.js'); await publishQuestion(this.context,e.questionId); } catch {}
    }
    return reply(e.status === 'requested' ? '凭据已保存到本机钥匙串；接入仍需群主确认，确认后自动填写并登录。'
      : '凭据已保存到本机钥匙串，助手会在本次 Nacos 独立窗口自动填写并登录。此消息不代表登录成功；验证码或扫码需要本人完成，后续还需确认命名空间范围。');
  }
}
