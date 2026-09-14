import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// One local stdio connection, not a public listener. No credentials are copied.
export class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch((error) => { this.close(); throw error; });
    return this.starting;
  }

  async initialize() {
    const child = (this.options.spawn ?? spawn)(this.options.codexBin ?? process.env.CODEX_BIN ?? 'codex',
      this.options.args ?? ['app-server', '--stdio'],
      { cwd: this.options.cwd, env: this.options.env, windowsHide: true, shell: false });
    this.child = child;
    this.generation++;
    let buffer = '';
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { /* Never forward raw diagnostics or secrets. */ }
      }
    });
    child.stderr.on('data', () => {});
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      this.starting = null;
      for (const request of this.pending.values()) request.reject(new Error('Codex app-server disconnected'));
      this.pending.clear();
      this.emit('disconnected');
    };
    child.once('error', fail);
    child.once('close', fail);
    const result = await this.request('initialize', {
      clientInfo: { name: 'agentos_runner', title: 'AgentOS', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 15_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, timeoutMs);
      const finish = (fn) => (value) => { clearTimeout(timer); this.pending.delete(id); fn(value); };
      const entry = { resolve: finish(resolve), reject: finish(reject) };
      this.pending.set(id, entry);
      try { this.write({ id, method, params }); } catch (error) { entry.reject(error); }
    });
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(message.id);
      if (message.error) entry?.reject(new Error(message.error.message ?? 'Codex RPC failed'));
      else entry?.resolve(message.result);
    } else if (message.id !== undefined) {
      // Conversation process has no permission to approve tools or perform actions.
      this.write({ id: message.id, error: { code: -32601, message: 'AgentOS conversation does not authorize tool requests' } });
    } else this.emit('notification', message);
  }

  async turn(params, { signal, timeoutMs = 90_000, onEvent } = {}) {
    await this.start();
    if (signal?.aborted) throw new Error('Codex turn aborted');
    return new Promise((resolve, reject) => {
      let turnId, final = '', done = false;
      const started = Date.now();
      const timing = { retries: 0 };
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('notification', receive);
        this.off('disconnected', disconnected);
        signal?.removeEventListener('abort', abort);
        if (error) { error.timing = { ...timing, totalMs: Date.now() - started }; reject(error); }
        else resolve(result);
      };
      const interrupt = () => {
        if (turnId) this.request('turn/interrupt', { threadId: params.threadId, turnId }, 3000).catch(() => {});
      };
      const abort = () => { interrupt(); finish(new Error('Codex turn aborted')); };
      const disconnected = () => finish(new Error('Codex app-server disconnected'));
      const timer = setTimeout(() => { interrupt(); finish(new Error('Codex 对话超过时限，未执行任务动作')); }, timeoutMs);
      const receive = ({ method, params: event = {} }) => {
        const eventTurnId = event.turnId ?? event.turn?.id;
        if (event.threadId !== params.threadId || (turnId && eventTurnId && eventTurnId !== turnId)) return;
        if (method === 'turn/started') turnId = event.turn.id;
        if (method === 'error') timing.retries += event.willRetry ? 1 : 0;
        if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) timing.firstOutputMs ??= Date.now() - started;
        onEvent?.(method, { elapsedMs: Date.now() - started, willRetry: event.willRetry ?? false });
        if (method === 'item/completed' && event.item?.type === 'agentMessage') final = event.item.text ?? final;
        if (method === 'turn/completed') {
          if (event.turn.status !== 'completed') return finish(new Error(event.turn.error?.message ?? `Codex turn ${event.turn.status}`));
          const message = event.turn.items?.filter((item) => item.type === 'agentMessage').at(-1);
          finish(null, { text: message?.text ?? final, threadId: params.threadId, turnId: event.turn.id,
            timing: { ...timing, totalMs: Date.now() - started } });
        }
      };
      this.on('notification', receive);
      this.on('disconnected', disconnected);
      signal?.addEventListener('abort', abort, { once: true });
      this.request('turn/start', params).then((result) => {
        turnId = result.turn.id;
        if (done) interrupt();
      }).catch((error) => finish(error));
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const entry of this.pending.values()) entry.reject(new Error('Codex app-server stopped'));
    this.pending.clear();
    this.emit('disconnected');
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
      child.kill();
    });
  }
}
