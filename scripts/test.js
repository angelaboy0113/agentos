// Test only public AgentOS tests, with opt-in settings isolated from the operator's runtime.
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-test-settings-'));
try {
  const requested=process.argv.slice(2);
  if(requested.some(n=>!/^test\/[A-Za-z0-9_.-]+\.test\.js$/.test(n)))throw Error('Only named public test files are accepted');
  const files = (await readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.js')&&(!requested.length||requested.includes('test/'+name))).sort().map((name) => path.join(root, 'test', name));
  if(requested.some(n=>!files.includes(path.join(root,n))))throw Error('Requested public test file not found');
  if (!files.length) throw new Error('No AgentOS tests found');
  const child = spawn(process.execPath, ['--test','--test-concurrency=2', ...files], { cwd: root, stdio: 'inherit', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENTOS_'))),
    AGENTOS_DATA_DIR:path.join(directory,'data'),AGENTOS_RUNTIME_DIR:path.join(directory,'runtime'),AGENTOS_LOG_DIR:path.join(directory,'logs'),AGENTOS_BROWSER_MODE:'isolated',
    AGENTOS_RECEPTION_FILE: path.join(directory,'reception.local.json'),
    AGENTOS_ENVIRONMENTS_FILE: path.join(directory, 'environments.local.json'),
    AGENTOS_CONVERSATION_FILE: path.join(directory, 'conversation.local.json'), AGENTOS_MEMORY_FILE: path.join(directory, 'memory.local.json'),
    AGENTOS_REPLY_ADDRESSING_FILE: path.join(directory,'reply-addressing.local.json') } });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
} finally { await rm(directory, { recursive: true, force: true }); }
