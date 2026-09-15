// Read-only dry-run: counts and hashes only. Never imports, sends messages, or executes jobs.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, memoryScope, memorySources, memoryProject } from '../src/control-plane/memory.js';
const args = process.argv.slice(2);
if (args.length > 1) throw new Error('Usage: node scripts/memory-check.js [data-directory]');
const root = path.resolve(args[0] ?? process.env.AGENTOS_DATA_DIR ?? './data');
const raw = await readFile(path.join(root, 'agentos.json'));
const state = JSON.parse(raw);
const scopes = new Map();
for (const turn of state.conversations ?? []) {
  if (turn.status !== 'sent') continue;
  const projectId = memoryProject(turn);
  scopes.set(memoryScope(turn, projectId), { turn: { ...turn, id: '__dry_run__' }, projectId });
}
let sources = 0;
for (const { turn, projectId } of scopes.values()) sources += memorySources(state, turn, projectId).length;
console.log(JSON.stringify({ mode: 'dry-run', writes: 0, stateSha256: fingerprint(raw.toString()),
  conversations: (state.conversations ?? []).length, jobs: (state.jobs ?? []).length,
  missionIds: new Set((state.jobs ?? []).map((job) => job.missionId).filter(Boolean)).size, scopes: scopes.size, eligibleSources: sources }));
