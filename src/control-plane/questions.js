import { createHash } from 'node:crypto';
import { createId } from '../shared/protocol.js';
import { conversationCard, jobCard, publicText } from './message-cards.js';
import { conversationTerminalMention, jobTerminalMention } from './requester-mention.js';
import { isAdministrator, isTaskCreator } from './authorization.js';
const pending = (turn) => ['queued', 'thinking', 'decided'].includes(turn.status);
export const activeQuestionJob = (job) => ['queued', 'running', 'cancelling', 'awaiting_approval', 'awaiting_clarification', 'awaiting_environment_approval'].includes(job.status);

// A reply is an explicit association. Never infer a question from model prose or the latest user in the group.
export function attachQuestion(state, turn, event, projects) {
  state.questions ??= {};
  const parents = [event.reply_to, event.root_id].filter(Boolean);
  const q = Object.values(state.questions).find((item) => item.chatId === turn.chatId && item.profile === turn.profile
    && item.projectId === turn.projectId && (isTaskCreator(projects, item, turn) || isAdministrator(projects, turn))
    && (parents.includes(item.messageId) || parents.includes(state.cardMessages?.[`question:${item.id}`]?.messageId)
      || state.conversations.some((other) => other.questionId === item.id && parents.includes(other.messageId))));
  const question = q ?? { id: createId('QST'), rootTurnId: turn.id, messageId: turn.messageId, chatId: turn.chatId,
    projectId: turn.projectId, profile: turn.profile, senderId: turn.senderId, createdAt: turn.createdAt,
    title: publicText(turn.content).replace(/\s+/g, ' ').slice(0, 60) || '附件问题', generation: 1 };
  if (q) question.generation = Math.max(question.generation, question.cardGeneration ?? 1) + 1;
  question.latestTurnId = turn.id;
  state.questions[question.id] = question;
  turn.questionId = question.id;
}
export function questionJob(state, questionId) {
  // Stages are appended in transition order. A completed predecessor never replaces its successor.
  return (state.jobs ?? []).filter((job) => job.questionId === questionId).at(-1) ?? null;
}
export function questionView(state, questionId, projects = {}) {
  const q = state.questions?.[questionId];
  if (!q) throw new Error('Question identity missing');
  const turn = state.conversations.find((item) => item.id === q.latestTurnId);
  const job = questionJob(state, q.id);
  const outstanding = state.conversations.some((item) => item.questionId === q.id && pending(item));
  const useJob = job && (activeQuestionJob(job) || turn.outcome?.jobId || turn.outcome?.nextJobId);
  const shown = useJob ? job : turn;
  const card = useJob ? jobCard(job) : conversationCard(turn);
  const terminal = !outstanding && (useJob ? !['queued', 'running', 'cancelling'].includes(job.status) : ['ready', 'sent'].includes(turn.status));
  const label = card.header.title.content;
  card.header.title.content = q.title;
  card.header.subtitle.content = `${q.id} · ${label}`;
  card.config.summary.content = `${q.title} · ${label}`;
  if (useJob) {
    const roles = { developer: '开发', owner_report: '负责人汇总', owner_intake: '负责人', pm: 'PM', qa: '测试', owner_audit: '审计' };
    const flow = state.jobs.filter((item) => item.questionId === q.id).slice(-6)
      .map((item) => `${roles[item.stage] ?? '处理'}${item.nextJobId ? ' ✓' : ''}`).join(' → ');
    card.body.elements[0].columns[0].elements.push({ tag: 'markdown', text_size: 'notation', content: `流程：${flow}` });
    if (outstanding) card.body.elements[0].columns[0].elements.push({ tag: 'markdown', text_size: 'notation', content: '已收到补充，负责人正在处理；任务进度仍显示在本卡。' });
  }
  const root = state.conversations.find((item) => item.id === q.rootTurnId);
  const mention = terminal ? (useJob
    ? jobTerminalMention({ ...job, senderId: q.senderId, originMessageId: q.messageId, originProfile: q.profile }, projects)
    : conversationTerminalMention({ ...turn, senderId: q.senderId, messageId: q.messageId, profile: q.profile, chatType: root.chatType })) : null;
  return { question: q, job: useJob ? job : null, card, terminal, mention,
    resultText: useJob ? shown.result?.finalMessage ?? '' : shown.response ?? '',
    destination: { replyTo: q.messageId, profile: q.profile } };
}
// Fence a snapshot against incoming replies, transitions and result changes between read and publish.
function sourceVersion(state, id) {
  const q = state.questions[id];
  return createHash('sha256').update(JSON.stringify([q.generation, q.latestTurnId,
    state.jobs.filter((j) => j.questionId === id).map((j) => [j.id, j.status, j.updatedAt, j.events.length, j.nextJobId, j.result]),
    state.conversations.filter((t) => t.questionId === id).map((t) => [t.id, t.status, t.response, t.outcome])])).digest('hex');
}
const locks = new WeakMap();
export function publishQuestion(context, id) {
  let queue = locks.get(context.store); if (!queue) { queue = new Map(); locks.set(context.store, queue); }
  const work = (queue.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const snapshot = await context.store.read();
    const version = sourceVersion(snapshot, id);
    const view = questionView(snapshot, id, context.projects);
    const key = `question:${id}`;
    // Reopening a round/attempt retains the message, but resets terminal notification delivery.
    let generation;
    await context.store.transact((state) => {
      const q = state.questions[id]; const old = state.cardMessages?.[key];
      q.cardGeneration = Math.max(q.generation, q.cardGeneration ?? 1);
      if (old?.terminal && !view.terminal && q.cardGeneration <= (old.generation ?? 1)) q.cardGeneration = old.generation + 1;
      generation = q.cardGeneration;
    });
    return context.cards.upsert(key, view.card, view.destination, { terminal: view.terminal, immediate: true,
      resultText: view.resultText, terminalMention: view.mention, generation,
      guard: (state) => { if (sourceVersion(state, id) !== version) throw new Error('Question changed during presentation; retry'); } });
  });
  queue.set(id, work); work.finally(() => { if (queue.get(id) === work) queue.delete(id); }).catch(() => {});
  return work;
}
