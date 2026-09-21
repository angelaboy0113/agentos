import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../src/shared/codex-app-server.js';
import { codexEnvironment, discoverWindowsCodexBinary, loadCodexRuntimeSettings, resolveCodexBinary, saveCodexRuntimeSettings } from '../src/shared/codex-runtime.js';

function fakeServer() {
  const requests = [], children = [];
  const spawn = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
    child.stdin.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        requests.push(msg);
        if (msg.id && msg.method) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id,
          result: msg.method === 'turn/start' ? { turn: { id: `turn-${msg.params.threadId}` } } : {} }) + '\n'));
      }
    });
    children.push(child);
    return child;
  };
  const app = new CodexAppServer({ spawn });
  const notify = (method, params) => children.at(-1).stdout.write(`${JSON.stringify({ method, params })}\n`);
  return { app, children, requests, notify };
}

test('stdio initialization is shared, answers finish without process exit and thread events stay isolated', async (t) => {
  const { app, children, requests, notify } = fakeServer();
  t.after(() => app.close());
  await Promise.all([app.start(), app.start()]);
  assert.equal(children.length, 1);
  assert.equal(requests.filter((r) => r.method === 'initialize').length, 1);
  const a = app.turn({ threadId: 'a', input: [] });
  const b = app.turn({ threadId: 'b', input: [] });
  await new Promise(setImmediate);
  notify('item/completed', { threadId: 'b', turnId: 'turn-b', item: { type: 'agentMessage', text: 'B' } });
  notify('turn/completed', { threadId: 'b', turn: { id: 'turn-b', status: 'completed', items: [] } });
  assert.equal((await b).text, 'B');
  notify('item/completed', { threadId: 'a', turnId: 'turn-a', item: { type: 'agentMessage', text: 'A' } });
  notify('turn/completed', { threadId: 'a', turn: { id: 'turn-a', status: 'completed', items: [] } });
  assert.equal((await a).text, 'A');
  assert.equal(children[0].exitCode, null);
});

test('timeout interrupts only its turn, rejects result and does not replay it', async (t) => {
  const { app, requests, notify } = fakeServer();
  t.after(() => app.close());
  const result = app.turn({ threadId: 'slow', input: [] }, { timeoutMs: 25 });
  await assert.rejects(result, /超过时限/);
  assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1);
  assert.equal(requests.filter((r) => r.method === 'turn/interrupt').length, 1);
  const next = app.turn({ threadId: 'new', input: [] });
  await new Promise(setImmediate);
  notify('turn/completed', { threadId: 'slow', turn: { id: 'turn-slow', status: 'completed', items: [] } });
  notify('turn/completed', { threadId: 'new', turn: { id: 'turn-new', status: 'completed', items: [{ type: 'agentMessage', text: 'new' }] } });
  assert.equal((await next).text, 'new');
});

test('server-initiated tool approval is rejected, process crash fails active turn and next call reconnects', async (t) => {
  const { app, children, requests } = fakeServer();
  t.after(() => app.close());
  await app.start();
  app.receive({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(requests.find((r) => r.id === 999).error.code, -32601);
  const active = app.turn({ threadId: 'old', input: [] });
  await new Promise(setImmediate);
  children[0].kill();
  await assert.rejects(active, /disconnected/);
  await app.start();
  assert.equal(children.length, 2);
});

test('Codex proxy overrides are child-local; embedded credentials are refused', async () => {
  const before = process.env.HTTPS_PROXY;
  const env = await codexEnvironment({ proxyUrl: 'http://127.0.0.1:12000' });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12000');
  assert.equal(process.env.HTTPS_PROXY, before);
  await assert.rejects(codexEnvironment({ proxyUrl: 'http://name:secret@localhost:12000' }), /credentials/);
});

test('an explicit empty proxy uses direct networking without mutating the parent environment', async () => {
  const before = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY };
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  process.env.ALL_PROXY = 'http://127.0.0.1:1';
  try {
    const env = await codexEnvironment({ proxyUrl: '' });
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.ALL_PROXY, undefined);
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:1');
  } finally {
    for (const [key, value] of Object.entries({ HTTP_PROXY: before.http, HTTPS_PROXY: before.https, ALL_PROXY: before.all })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('AgentOS runtime settings preserve non-model Codex options and validate effort', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-runtime-'));
  const file = path.join(directory, 'runtime.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, JSON.stringify({ proxyUrl: '', codexBin: '/opt/codex' }));
  await saveCodexRuntimeSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'high' }, { file });
  assert.deepEqual(await loadCodexRuntimeSettings({ file }), { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    proxyUrl: '', codexBin: '/opt/codex', model: 'gpt-5.6-sol', reasoningEffort: 'high',
  });
  await assert.rejects(saveCodexRuntimeSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'impossible' }, { file }), /reasoning effort/);
});

test('desktop Codex discovery selects the newest valid executable directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  await mkdir(oldDir);
  await mkdir(newDir);
  const oldBin = path.join(oldDir, 'codex.exe');
  const newBin = path.join(newDir, 'codex.exe');
  await writeFile(oldBin, 'old');
  await writeFile(newBin, 'new');
  await utimes(oldBin, new Date(1_000), new Date(1_000));
  await utimes(newBin, new Date(2_000), new Date(2_000));
  assert.equal(await discoverWindowsCodexBinary(root), newBin);
});

test('the codex sentinel in CODEX_BIN still enables desktop discovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versionDir = path.join(root, 'current');
  await mkdir(versionDir);
  const binary = path.join(versionDir, 'codex.exe');
  await writeFile(binary, 'current');
  const before = process.env.CODEX_BIN;
  process.env.CODEX_BIN = 'codex';
  try {
    assert.equal(await resolveCodexBinary(undefined, { discoveryRoot: root }), binary);
  } finally {
    if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before;
  }
});
