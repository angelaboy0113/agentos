// Test only public AgentOS tests, with opt-in settings isolated from the operator's runtime.
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-test-settings-'));
try {
  const files = (await readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join(root, 'test', name));
  if (!files.length) throw new Error('No AgentOS tests found');
  const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env,
    AGENTOS_ENVIRONMENTS_FILE: path.join(directory, 'environments.local.json'),
    AGENTOS_CONVERSATION_FILE: path.join(directory, 'conversation.local.json'), AGENTOS_MEMORY_FILE: path.join(directory, 'memory.local.json') } });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
} finally { await rm(directory, { recursive: true, force: true }); }
