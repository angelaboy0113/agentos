import { loadEnvironments, verifyPlan, isEnvironmentOwner } from '../shared/environment-access.js';
import { publishQuestion, questionJob } from './questions.js';
import { jobActionVersion, jobCard } from './message-cards.js';
import { nextStage } from '../shared/protocol.js';
import { canContinueTask, isAdministrator, isTaskCreator } from './authorization.js';
import { handleResultPage } from './result-page-actions.js';

const parse = (value) => typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {};

// Called ONLY by the authenticated, profile-scoped CLI event ingress, never by the public webhook.
export async function handleCardAction(context, event) {
  const { store, cards, projects, agents } = context;
  if (event.type !== 'card.action.trigger' || !event.event_id || !event.operator_id) return { ignored: true };
  const profile = event.agent_profile ?? null;
  if (!Object.values(agents.agents ?? {}).some((agent) => (agent.profile || null) === profile)) return { ignored: true };
  let parsedValue;
  try { parsedValue = parse(event.action_value); } catch { return { ignored: true }; }
  if (projects.retiredChatIds?.includes(event.chat_id) && !['result_page', 'refresh'].includes(parsedValue.action)) return { ignored: true, reason: 'retired_group' };
  if (parsedValue.action === 'result_page') return handleResultPage(context, event);
  const state = await store.read();
  const entry = Object.entries(state.cardMessages ?? {}).find(([key, item]) => (key.startsWith('job:') || key.startsWith('question:'))
    && item.messageId === event.message_id && item.destination.profile === profile);
  if (!entry || !event.card_content) return { ignored: true, reason: '没有可验证的原始任务卡片' };
  const [key, savedCard] = entry;
  const questionId = key.startsWith('question:') ? key.slice('question:'.length) : null;
  const jobId = questionId ? questionJob(state, questionId)?.id : key.split(':')[1];
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || job.chatId !== event.chat_id || (questionId ? state.questions?.[questionId]?.profile : job.agentProfile) !== profile) return { ignored: true };
  const effectKey = `card-action:${profile}:${event.event_id}`;
  const admin = isAdministrator(projects, { profile, senderId: event.operator_id });
  const creator = isTaskCreator(projects, job, { profile, senderId: event.operator_id });
  let result;
  try {
    if (!admin && !creator) throw new Error('只有本任务发起人或真人管理员可以操作；转交后身份未识别时，请核对跨应用真人身份映射。');
    const value = parse(event.action_value);
    const action = event.action_name?.startsWith('clarify_') ? 'clarify' : value.action;
    const version = action === 'clarify' ? event.action_name.slice('clarify_'.length) : value.version;
    if (!['cancel', 'approve', 'approve_environment', 'clarify', 'refresh'].includes(action)) throw new Error('不支持的卡片操作。');
    if (action === 'approve' && !admin) throw new Error('只有真人管理员可以确认进入下一阶段。');
    // Recheck inside the same state transaction as mutation; old cards cannot control a new attempt.
    const guard = (freshState, current) => {
      const freshCard = freshState.cardMessages?.[key];
      if (freshCard?.messageId !== event.message_id || freshCard.destination.profile !== profile
        || current.chatId !== event.chat_id || (questionId ? freshState.questions?.[questionId]?.profile : current.agentProfile) !== profile
        || (questionId && questionJob(freshState, questionId)?.id !== current.id)
        || jobActionVersion(current) !== version || !hasAction(freshCard.card, action, version)) {
        throw new Error('这张卡片已过期，请操作最新任务卡片。');
      }
    };
    if (action === 'refresh') {
      guard(state, job);
      result = { job, message: '已刷新任务状态。' };
    } else if (action === 'cancel') {
      const updated = await store.cancel(job.id, event.operator_id, effectKey, guard);
      result = { job: updated, message: updated.status === 'cancelling' ? '已请求停止，等待执行器确认退出。' : '任务已取消。' };
    } else if (action === 'approve_environment') {
      const e = verifyPlan(await loadEnvironments(), job.environmentAccess ?? {});
      if (!isEnvironmentOwner(e, { profile, senderId: event.operator_id })) throw new Error('只有本环境指定负责人可以批准查询');
      const updated = await store.approveEnvironment(job.id, event.operator_id, job.environmentAccess.scopeHash, effectKey, guard);
      result = { job: updated, message: '本次只读查询已批准并排队，不授予其他查询或修改权限。' };
    } else if (action === 'approve') {
      const role = nextStage(job.workflow, job.stage);
      const routing = { agentRole: role, agentProfile: agents.agents?.[role === 'owner_report' ? 'owner_intake' : role]?.profile ?? null };
      const approved = await store.approve(job.id, event.operator_id, routing, effectKey, guard);
      result = { ...approved, message: '已确认，下一阶段已排队。' };
    } else {
      if (!canContinueTask(projects, job, { profile, senderId: event.operator_id })) {
        throw new Error('只有真人管理员可以补充并继续非只读任务；普通成员只能继续自己的只读源码排查。');
      }
      const instruction = String(parse(event.form_value).clarification ?? '').trim();
      if (!instruction || instruction.length > 1000) throw new Error('请填写 1–1000 字的补充信息。');
      const updated = await store.resumeClarification(job.id, { instruction }, effectKey, guard);
      result = { job: updated, resubmitted: true, message: '补充已提交，当前阶段重新排队。' };
    }
    // Re-delivery retries only presentation. The business mutation above is effect-idempotent.
    const latest = await store.getJob(job.id);
    const shown = result.resubmitted || jobActionVersion(latest) !== version ? { ...latest, status: 'resubmitted' } : latest;
    if (questionId) await publishQuestion(context, questionId);
    else await cards.upsert(key, jobCard(shown), savedCard.destination, {
      terminal: !['queued', 'running', 'cancelling'].includes(shown.status), immediate: true,
      resultText: shown.result?.finalMessage,
    });
    await store.transact((fresh) => {
      fresh.cardCallbackChecks ??= {};
      fresh.cardCallbackChecks[profile ?? 'default'] = { at: new Date().toISOString(), action, messageId: event.message_id };
    });
    return { ok: true, message: result.message };
  } catch (error) {
    // Do not echo arbitrary callback input, tokens or raw errors into the group.
    const known = /^(只有|这张卡片|请填写|不支持|当前任务|查询授权|查询申请)/.test(error.message) ? error.message : '操作未完成：任务状态可能已变化，请刷新后重试。';
    const noticeKey = `${effectKey}:notice`;
    const accepted = await store.transactEffect(noticeKey, () => ({ message: known }));
    const delivered = (await store.read()).cardActionNotices?.[noticeKey];
    if (!delivered) {
      await context.feishu.reply(event.message_id, accepted.message, { profile, replyInThread: savedCard.destination.replyInThread, idempotencyKey: noticeKey });
      await store.transact((fresh) => { fresh.cardActionNotices ??= {}; fresh.cardActionNotices[noticeKey] = true; });
    }
    return { ok: false, message: accepted.message };
  }
}

function hasAction(node, action, version) {
  if (!node || typeof node !== 'object') return false;
  if (action === 'clarify' && node.tag === 'button' && node.name === `clarify_${version}`) return true;
  if (node.type === 'callback' && node.value?.action === action && node.value?.version === version) return true;
  return Object.values(node).some((child) => hasAction(child, action, version));
}
