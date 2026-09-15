import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
// One app-server owner. A pending turn after a crash is uncertain, never automatically replayed in the same thread.
export class SessionRegistry {
  constructor(dataDir) { this.file = path.join(dataDir, 'codex-conversations.json'); this.queue = Promise.resolve(); }
  async read() {
    try { const value = JSON.parse(await readFile(this.file, 'utf8')); if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) throw new Error('Invalid session registry'); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, sessions: {} }; if (error instanceof SyntaxError) throw new Error('Invalid session registry; original file preserved'); throw error; }
  }
  async get(key) { return (await this.read()).sessions[hash(key)]; }
  async set(key, value) {
    const run = this.queue.then(async () => {
      const data = await this.read(); data.sessions[hash(key)] = value;
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await chmod(tmp, 0o600); await rename(tmp, this.file);
    });
    this.queue = run.catch(() => {}); return run;
  }
}
