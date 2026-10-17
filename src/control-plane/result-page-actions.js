import {cardActionChat} from './private-cards.js';
import { questionView } from './questions.js';
import { detailVersion, resultPages, withResultPage } from './result-presentation.js';
import { isAdministrator, isTaskCreator } from './authorization.js';

// Presentation-only callbacks: no Job mutation, Runner dispatch or model invocation.
export async function handleResultPage(context, event) {
  // Verify the locally persisted sent card below; optional CLI user_dsl enrichment is not authority.
  let value;
  try { value = typeof event.action_value === 'string' ? JSON.parse(event.action_value) : event.action_value; }
  catch { return { ignored: true }; }
  try {
    const result = await context.store.transactEffect(`result-page:${event.agent_profile}:${event.event_id}`, (state) => {
      const found = Object.entries(state.cardMessages ?? {}).find(([, item]) => item.messageId === event.message_id
        && item.destination.profile === event.agent_profile);
      if (!found) throw new Error('unknown card');
      const [key, entry] = found;
      if(entry.destination.visibility==='requester'&&entry.destination.openId!==event.operator_id)throw new Error('private recipient mismatch');
      const sourceKey=entry.destination.sourceKey??key;
      const view = sourceKey.startsWith('question:') ? questionView(state, sourceKey.slice(9), context.projects) : null;
      const record = view ? view.question : sourceKey.startsWith('job:') ? state.jobs.find((job) => job.id === sourceKey.split(':')[1])
        : state.conversations?.find((turn) => `chat:${turn.id}` === sourceKey);
      if (!record || record.chatId !== cardActionChat(entry,event) || !entry.terminal) throw new Error('wrong scope');
      const admin = isAdministrator(context.projects, { profile: event.agent_profile, senderId: event.operator_id });
      const creator = isTaskCreator(context.projects, record, { profile: event.agent_profile, senderId: event.operator_id });
      if (!admin && !creator && !(entry.destination.visibility==='requester'&&entry.destination.openId===event.operator_id)) throw new Error('not authorized');
      const pages = entry.detailPages ?? [];
      if (!Number.isInteger(value.page) || value.page < 0 || value.page >= pages.length
        || value.version !== detailVersion(pages) || !containsPageAction(entry.card, value)) throw new Error('stale page');
      // Validate the button against the published version first. Then rebuild only
      // presentation from the original evidence, including cards saved by older versions.
      const source = view ? view.resultText : sourceKey.startsWith('job:') ? record.result?.finalMessage : record.response;
      const formatted = typeof source === 'string' && source.trim() ? resultPages(source) : pages;
      entry.detailPages = formatted;
      entry.card = withResultPage(entry.card, formatted, Math.min(value.page, formatted.length - 1), true);
      entry.revision += 1;
      entry.updatedAt = new Date().toISOString();
      return { key };
    });
    await context.cards.flush(result.key, true);
    return { ok: true, message: '详情页已更新；未执行任何任务。' };
  } catch {
    return { ok: false, message: '详情未切换：请确认操作最新卡片，且你是发起人或管理员。' };
  }
}

function containsPageAction(node, value) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'callback' && node.value?.action === 'result_page'
    && node.value.version === value.version && node.value.page === value.page) return true;
  return Object.values(node).some((child) => containsPageAction(child, value));
}
