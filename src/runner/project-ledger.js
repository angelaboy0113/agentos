import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { clean } from '../control-plane/memory.js';

export const DEFAULT_LEDGER_PATHS = ['AGENTS.md', 'progress.md', 'docs/spec/project.spec.md'];
const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const allowed = (name) => typeof name === 'string' && name.length < 300 && !path.isAbsolute(name)
  && !name.includes('\\') && !name.includes(':') && !name.split('/').some((part) => ['..', '.git', 'node_modules', 'data', '.codex', '.lark-cli'].includes(part)
    || /^(\.env(?:\..*)?|.*\.local\.json|auth\.json|credentials.*)$/i.test(part)) && /\.(md|txt|xlsx)$/i.test(name);
// Small, explicit read-only entry points, never an unrestricted directory walk or remote document fetch.
export async function readProjectLedger(workspace, project, sourceSync) {
  const entries = project.knowledgePaths ?? DEFAULT_LEDGER_PATHS;
  if (!Array.isArray(entries) || entries.length > 12 || entries.some((entry) => !allowed(entry))) throw new Error('Invalid project.knowledgePaths');
  const root = await realpath(workspace), result = [];
  for (const entry of [...new Set(entries)]) {
    let handle;
    try {
      const target = await realpath(path.resolve(root, entry));
      if (!inside(root, target)) throw new Error('outside');
      const relative = path.relative(root, target).replaceAll('\\', '/');
      if (!allowed(relative)) throw new Error('forbidden');
      handle = await open(target, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('size');
      const raw = await handle.readFile();
      if (raw.length > 5 * 1024 * 1024) throw new Error('size');
      const repository = [...(sourceSync?.repositories ?? [])].sort((a, b) => b.path.length - a.path.length)
        .find((item) => item.path === '.' || relative.startsWith(`${item.path}/`));
      result.push({ path: relative, sha256: createHash('sha256').update(raw).digest('hex'),
        bytes: raw.length, format: path.extname(relative).slice(1),
        excerpt: relative.endsWith('.xlsx') ? null : clean(raw.toString('utf8')).slice(0, 2000),
        contentLoaded: !relative.endsWith('.xlsx'),
        truncated: relative.endsWith('.xlsx') || raw.toString('utf8').length > 2000,
        readAt: new Date().toISOString(), repository: repository ? { branch: repository.branch, commit: repository.commit } : null,
        applicability: 'local_document_claims_not_proof_of_code_or_deployment' });
    } catch (error) {
      result.push({ path: entry, unavailable: error.code === 'ENOENT' ? 'missing' : 'unsafe_or_unreadable' });
    } finally { await handle?.close(); }
  }
  return result;
}
