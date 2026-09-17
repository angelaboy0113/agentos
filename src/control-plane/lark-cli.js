import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function resolveLarkCliEntry(explicit = '') {
  return path.resolve(explicit || path.join(
    path.dirname(process.execPath), 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js',
  ));
}

export function spawnLarkCli(args, options = {}) {
  const entry = resolveLarkCliEntry(options.cliEntry);
  const profileArgs = options.profile ? ['--profile', options.profile] : [];
  return spawn(process.execPath, [entry, ...profileArgs, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.configDir ? { LARKSUITE_CLI_CONFIG_DIR: options.configDir } : {}),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
    windowsHide: true,
    stdio: options.stdio ?? [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

export function runLarkCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnLarkCli(args, options);
    if (options.input) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const timer = setTimeout(() => { child.kill(); reject(new Error('lark-cli request timed out')); }, options.timeoutMs ?? 30_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`lark-cli exited ${code}: ${stderr || stdout}`));
      try {
        const result = stdout.trim() ? JSON.parse(stdout) : {};
        if (result.ok === false || (typeof result.code === 'number' && result.code !== 0)) return reject(new Error('lark-cli API request rejected'));
        resolve(result);
      } catch {
        resolve({ raw: stdout.trim() });
      }
    });
  });
}

// Preserve existing valid keys; hash longer business effect IDs deterministically.
export function larkIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length <= 50) return value;
  return `agentos-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

export class LarkCliFeishuClient {
  constructor(config = {}) {
    this.cliEntry = config.cliEntry;
    this.cwd = path.resolve(config.dataDir ?? './data', 'lark-cli');
  }

  async reply(messageId, text, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const digest = createHash('sha256').update(`${messageId}\n${text}`).digest('hex').slice(0, 20);
    return runLarkCli([
      'im', '+messages-reply', '--as', 'bot', '--message-id', messageId,
      ...(options.replyInThread ? ['--reply-in-thread'] : []),
      '--text', text, '--idempotency-key', larkIdempotencyKey(options.idempotencyKey ?? `agentos-${digest}`), '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: options.timeoutMs });
  }

  async send(chatId, text, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const digest = createHash('sha256').update(`${chatId}\n${text}`).digest('hex').slice(0, 20);
    return runLarkCli([
      'im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--text', text, '--idempotency-key', `agentos-${digest}`, '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile });
  }

  async replyCard(messageId, card, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    return runLarkCli(['im', '+messages-reply', '--as', 'bot', '--message-id', messageId,
      ...(options.replyInThread ? ['--reply-in-thread'] : []),
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', larkIdempotencyKey(options.idempotencyKey), '--json'],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: 15_000 });
  }

  async sendCard(chatId, card, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    return runLarkCli(['im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', larkIdempotencyKey(options.idempotencyKey), '--json'],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: 15_000 });
  }

  async updateCard(messageId, card, options = {}) {
    return this.cardRequest('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: JSON.stringify(card) }, options);
  }

  async cardRequest(method, route, body, options) {
    await mkdir(this.cwd, { recursive: true });
    // stdin avoids Windows command-line limits and keeps message contents out of process arguments.
    return runLarkCli(['api', method, route, '--as', 'bot', '--data', '-', '--json',
      ...(options.params ? ['--params', JSON.stringify(options.params)] : [])],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, input: JSON.stringify(body), timeoutMs: 15_000 });
  }

  async downloadMessageResource(jobId, messageId, fileKey, type, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const relative = path.join('resources', jobId, fileKey);
    const result = await runLarkCli([
      'im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId,
      '--file-key', fileKey, '--type', type, '--output', relative, '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile });
    const output = findPath(result) ?? relative;
    return {
      id: fileKey,
      path: path.resolve(this.cwd, output),
      type,
      contentType: type === 'image' ? 'image/*' : 'application/octet-stream',
    };
  }
}

function findPath(value) {
  if (typeof value === 'string' && /[\\/]/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPath(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/path|output|file/i.test(key) && typeof item === 'string') return item;
      const found = findPath(item);
      if (found) return found;
    }
  }
  return null;
}
