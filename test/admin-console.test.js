import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlPlane } from '../src/control-plane/server.js';
import { adminOverview } from '../src/control-plane/admin-view.js';

test('admin overview keeps a runner online while it holds a live job lease', () => {
  const now = Date.now();
  const overview = adminOverview({
    jobs: [{ status: 'running', lease: { runnerId: 'runner-1', expiresAt: new Date(now + 60_000).toISOString() } }],
    runners: { 'runner-1': { runnerId: 'runner-1', lastSeenAt: new Date(now - 60_000).toISOString() } },
  }, {}, now);
  assert.equal(overview.runner.online, true);
});

test('local admin console serves task records and safely updates runtime settings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-admin-'));
  const runtimeFile = path.join(directory, 'codex-runtime.local.json');
  const app = await createControlPlane({
    host: '127.0.0.1', port: 0, dataDir: directory,
    storeFile: path.join(directory, 'agentos.json'), codexRuntimeFile: runtimeFile,
    adminToken: 'admin', runnerToken: 'runner',
    projects: { chatProjectMap: {}, projects: { demo: { displayName: 'Demo' } } },
    agents: { agents: {} }, conversationResponder: async () => ({ action: 'reply', intent: 'none', reply: 'ok' }),
    feishuClient: { enabled: false, reply: async () => {}, send: async () => {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await app.conversations.stop(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await app.store.createJob({ projectId: 'demo', projectName: 'Demo', workflow: 'developer_delivery',
    stage: 'developer', instruction: '修复登录异常', status: 'running' });
  await app.store.appendEvent(created.job.id, { type: 'completed', result: { outcome: 'ready', finalMessage: '已经修复',
    model: 'gpt-5.6-sol', reasoningEffort: 'high', timing: { totalMs: 3200 } } });
  await app.store.transact((state) => { state.jobs[0].status = 'completed'; });

  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AgentOS 控制台/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const cookie = page.headers.get('set-cookie').split(';')[0];

  const overview = await fetch(`${base}/api/v1/admin/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  const summary = await overview.json();
  assert.equal(summary.overview.counts.completed24h, 1);
  assert.equal(summary.overview.recent[0].model, 'gpt-5.6-sol');

  const denied = await fetch(`${base}/api/v1/admin/settings/runtime`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
  const saved = await fetch(`${base}/api/v1/admin/settings/runtime`, { method: 'PUT', headers: {
    cookie, origin: base, 'x-agentos-admin': '1', 'content-type': 'application/json',
  }, body: JSON.stringify({ model: 'gpt-6-astra', reasoningEffort: 'xhigh' }) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).runtime, { model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  assert.deepEqual(JSON.parse(await readFile(runtimeFile, 'utf8')), { model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  assert.equal((await app.store.read()).adminAudit.at(-1).action, 'runtime_settings_changed');
});
