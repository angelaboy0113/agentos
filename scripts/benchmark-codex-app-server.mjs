// Synthetic input only. Never reads project data or sends Feishu messages.
import { CodexAppServer } from '../src/shared/codex-app-server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'agentos-latency-'));
const started = Date.now();
const app = new CodexAppServer({ cwd, args: ['app-server', '--stdio',
  '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.shell_tool=false',
  '-c', 'features.unbounded_connection_retries=false'] });
try {
  await app.start();
  console.log(JSON.stringify({ stage: 'initialized', elapsedMs: Date.now() - started }));
  const auth = await app.request('account/read', { refreshToken: false });
  console.log(JSON.stringify({ stage: 'auth', type: auth.account?.type }));
  const thread = await app.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
  console.log(JSON.stringify({ stage: 'thread', model: thread.model, elapsedMs: Date.now() - started }));
  for (const text of ['你好，只回复一句问候。', '刚才我说了什么？用一句话回答。']) {
    const result = await app.turn({ threadId: thread.thread.id, effort: 'low', input: [{ type: 'text', text }] },
      { timeoutMs: 65_000, onEvent: (event, timing) => { if (['error', 'turn/started', 'turn/completed'].includes(event)) console.log(JSON.stringify({ event, ...timing })); } });
    console.log(JSON.stringify({ stage: 'answer', text: result.text, ...result.timing }));
  }
} catch (error) { console.log(JSON.stringify({ stage: 'failed', message: error.message, timing: error.timing })); process.exitCode = 1; }
finally { await app.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
