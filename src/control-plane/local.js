import { randomBytes } from 'node:crypto';
import { createControlPlane } from './server.js';
import { startLarkEventSources } from './lark-event-source.js';
import { AgentRunner } from '../runner/index.js';
import { runnerConfig } from '../runner/config.js';

async function main() {
  const adminToken = process.env.AGENTOS_ADMIN_TOKEN || randomBytes(32).toString('hex');
  const runnerToken = process.env.AGENTOS_RUNNER_TOKEN || randomBytes(32).toString('hex');
  const { server, config, projects, agents } = await createControlPlane({
    adminToken,
    runnerToken,
    feishu: { transport: 'lark-cli' },
  });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[control-plane] listening on http://${config.host}:${config.port}`);
  const eventSources = await startLarkEventSources({
    serverUrl: `http://${config.host}:${config.port}`,
    adminToken: config.adminToken,
    dataDir: config.dataDir,
    cliEntry: config.feishu.cliEntry,
  }, agents.agents);
  const localRunner = new AgentRunner(await runnerConfig({
    serverUrl: `http://${config.host}:${config.port}`,
    runnerToken,
    projects: projects.projects,
    executor: process.env.AGENTOS_RUNNER_EXECUTOR || 'codex',
  }));
  const runnerRunning = localRunner.start();
  const stop = () => {
    for (const { source } of eventSources) source.stop();
    localRunner.stop();
    server.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await Promise.all([...eventSources.map(({ running }) => running), runnerRunning]);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
