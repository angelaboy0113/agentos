import path from 'node:path';
import {publishQuestion} from './questions.js';
import {recoverLocalExecutions} from '../runner/local-executions.js';
import { loadConversationSettings } from './conversation-settings.js';
import { randomBytes } from 'node:crypto';
import { createControlPlane } from './server.js';
import { startLarkEventSources } from './lark-event-source.js';
import { createRunnerPool } from '../runner/index.js';
import { runnerConfig } from '../runner/config.js';

async function main() {
  const adminToken = process.env.AGENTOS_ADMIN_TOKEN || randomBytes(32).toString('hex');
  const runnerToken = process.env.AGENTOS_RUNNER_TOKEN || randomBytes(32).toString('hex');
  const app = await createControlPlane({
    adminToken,
    runnerToken,
    feishu: { transport: 'lark-cli' },
  });
  const {server,config,projects,agents,store}=app;
  const localExecutionRegistry=path.join(config.dataDir,'local-executions');
  await recoverLocalExecutions(store,localExecutionRegistry);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[control-plane] listening on http://${config.host}:${config.port}`);
  const savedState=await store.read();
  for(const id of new Set(Object.values(savedState.environmentEnrollments??{}).map(e=>e.questionId))) {
    if(savedState.cardMessages?.[`question:${id}`]) {
      try { await publishQuestion(app,id); } catch { console.error("[enrollment-card] 启动刷新未完成，可在卡片重试"); }
    }
  }
  const eventSources = await startLarkEventSources({
    serverUrl: `http://${config.host}:${config.port}`,
    adminToken: config.adminToken,
    dataDir: config.dataDir,
    editedMentions: (await loadConversationSettings(config.conversationFile)).editedMentions,
    watchedChatIds: [...new Set([...Object.keys(projects.chatProjectMap ?? {}), ...Object.keys(projects.chatProfileProjectMap ?? {})])].filter(id=>!projects.retiredChatIds?.includes(id)),
    cliEntry: config.feishu.cliEntry,
    larkConfigFile: process.env.AGENTOS_LARK_CONFIG_FILE,
    eventConfigRoot: process.env.AGENTOS_EVENT_CONFIG_ROOT,
  }, agents.agents);
  const localRunnerConfig = await runnerConfig({
    serverUrl: `http://${config.host}:${config.port}`,
    runnerToken,
    localExecutionRegistry,
    dataDir:config.dataDir,
    projects: projects.projects,
    executor: process.env.AGENTOS_RUNNER_EXECUTOR || 'codex',
  });
  const localRunners = createRunnerPool(localRunnerConfig);
  const runnerRunning = Promise.all(localRunners.map((runner) => runner.start()));
  const stop = () => {
    for (const { source } of eventSources) source.stop();
    for (const runner of localRunners) runner.stop();
    server.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await Promise.all([...eventSources.map(({ running }) => running), runnerRunning]);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
