// Default is a local CLI dry-run. --send-preview explicitly sends ONE labelled demo card.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LarkCliFeishuClient, runLarkCli } from '../src/control-plane/lark-cli.js';
import { jobCard } from '../src/control-plane/message-cards.js';
import { ExecutionActivity } from '../src/shared/execution-activity.js';
import { messageIdOf } from '../src/control-plane/live-cards.js';

const start = Date.now();
const job = { id: 'PREVIEW-NOT-A-TASK', stage: 'developer', projectName: '样式预览 · 不执行开发任务',
  status: 'running', createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(),
  events: [{ id: 'preview', type: 'started', at: new Date(start).toISOString() }] };
function preview() {
  const value = jobCard(job);
  value.header.title.content = `样式预览 · ${value.header.title.content}`;
  value.config.summary.content = value.header.title.content;
  return value;
}
const directory = path.resolve('data/card-previews');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'running.json'), JSON.stringify(preview(), null, 2));
if (!process.argv.includes('--send-preview')) {
  for (const status of ['awaiting_clarification', 'awaiting_approval', 'cancelling', 'cancelled', 'completed']) {
    const sample = jobCard({ ...job, status, result: { summary: '演示结论：已找到校验入口；未验证线上环境。',
      finalMessage: '### 详细证据\n仅用于本地验证表单、结果分页与按钮结构。\n'.repeat(100) } });
    const result = await runLarkCli(['api', 'PATCH', '/open-apis/im/v1/messages/om_preview_not_sent', '--as', 'bot',
      '--data', '-', '--dry-run', '--json'], { input: JSON.stringify({ content: JSON.stringify(sample) }) });
    if (result.ok !== true) throw new Error(`Card dry-run failed: ${status}`);
    await writeFile(path.join(directory, `${status}.json`), JSON.stringify(sample, null, 2));
  }
  const reply = await runLarkCli(['im', '+messages-reply', '--as', 'bot', '--message-id', 'om_preview_not_sent',
    '--msg-type', 'interactive', '--content', JSON.stringify(preview()), '--dry-run', '--json']);
  const patch = await runLarkCli(['api', 'PATCH', '/open-apis/im/v1/messages/om_preview_not_sent', '--as', 'bot',
    '--data', '-', '--dry-run', '--json'], { input: JSON.stringify({ content: JSON.stringify(preview()) }) });
  console.log(JSON.stringify({ dryRun: true, replyOk: reply.ok !== false, patchOk: patch.ok !== false,
    output: path.join(directory, 'running.json'), bytes: Buffer.byteLength(JSON.stringify(preview())) }));
} else {
  const config = JSON.parse(await readFile('config/projects.local.json', 'utf8'));
  const agents = JSON.parse(await readFile('config/agents.local.json', 'utf8'));
  const groups = Object.entries(config.chatProjectMap).filter(([, project]) => project === 'tpm');
  if (groups.length !== 1) throw new Error('Preview target is ambiguous; do not send.');
  const profile = agents.agents.owner_intake.profile;
  const client = new LarkCliFeishuClient({ dataDir: './data' });
  const id = messageIdOf(await client.sendCard(groups[0][0], preview(), { profile, idempotencyKey: `aos-style-preview-${start}` }));
  if (!id) throw new Error('Preview returned no message ID');
  await writeFile(path.join(directory, 'sent.json'), JSON.stringify({ messageId: id, profile }));
  const activity = new ExecutionActivity();
  for (const type of ['item.started', 'item.completed']) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const snapshot = activity.accept({ type, item: { id: 'demo', type: 'command_execution', command: 'git diff --stat', exit_code: 0 } });
    job.events.push({ type: 'progress', phase: 'tool_activity', at: new Date().toISOString(), activity: snapshot });
    await client.updateCard(id, preview(), { profile });
  }
  job.status = 'completed'; job.updatedAt = new Date().toISOString();
  job.result = { finalMessage: '这是一张样式预览卡。上述命令和计数是演示数据，没有运行 Git、Codex 或任何开发任务。正式任务会展示真实事件。' };
  await client.updateCard(id, preview(), { profile });
  console.log(JSON.stringify({ previewSent: true, updatedSameCard: 3, messageId: id }));
}
