import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LarkEventSource } from '../src/control-plane/lark-event-source.js';
import { LarkCliFeishuClient } from '../src/control-plane/lark-cli.js';

test('long callback notice keys pass CLI limit and preserve retry identity across text and cards', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'callback-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cliEntry = path.join(dir, 'cli.cjs');
  await writeFile(cliEntry, `const a=process.argv.slice(2); const key=a[a.indexOf('--idempotency-key')+1]; if(key.length>50)process.exit(2);console.log(JSON.stringify({ok:true,key}));`);
  const client = new LarkCliFeishuClient({ cliEntry, dataDir: dir });
  const key = 'card-action:owner:' + 'x'.repeat(40) + ':notice';
  for (const method of ['reply', 'replyCard', 'sendCard']) {
    const a = await client[method]('message', 'payload', { idempotencyKey: key });
    const b = await client[method]('message', 'payload', { idempotencyKey: key });
    const c = await client[method]('message', 'payload', { idempotencyKey: key + 'other' });
    assert.equal(a.key, b.key); assert.notEqual(a.key, c.key); assert.ok(a.key.length <= 50);
    assert.equal((await client[method]('message', 'payload', { idempotencyKey: 'old-valid' })).key, 'old-valid');
  }
});

test('failed callback persists without blocking later approval; retry keeps same event and stop clears timers', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'callback-queue-'));
  const original = globalThis.fetch; const calls = []; let fail = true;
  const source = new LarkEventSource({ cwd: dir, eventKey: 'card.action.trigger', profile: 'owner', serverUrl: 'http://local', callbackRetryMs: 10000 });
  t.after(async () => { source.stop(); globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); });
  globalThis.fetch = async (_, opts) => { const event = JSON.parse(opts.body); calls.push(event); return { ok: event.event_id !== 'old-refresh' || !fail }; };
  await source.handleLine(JSON.stringify({ type: 'card.action.trigger', event_id: 'old-refresh', action_value: 'refresh' }));
  const [file] = source.callbackRetries.keys(); assert.ok(file); assert.equal(JSON.parse(await readFile(file)).event_id, 'old-refresh');
  await source.handleLine(JSON.stringify({ type: 'card.action.trigger', event_id: 'new-approve', action_value: 'approve_environment' }));
  assert.deepEqual(calls.map(e => e.event_id), ['old-refresh', 'new-approve']);
  fail = false; await source.deliverCallback(file); assert.equal(source.callbackRetries.size, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(calls[2].event_id, 'old-refresh');
  fail = true; await source.handleLine(JSON.stringify({ type: 'card.action.trigger', event_id: 'old-refresh' }));
  source.stop(); assert.equal(source.callbackRetries.size, 0);
});
