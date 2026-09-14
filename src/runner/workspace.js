import { mkdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sanitizeSegment } from '../shared/protocol.js';

export async function prepareWorkspace(job, project, worktreeRoot) {
  if (!project?.repoPath) throw new Error(`Project ${job.projectId} has no local repoPath`);
  const repoPath = path.resolve(project.repoPath);
  await assertDirectory(repoPath);

  // Analysis reads the configured live checkout, including independent child repos.
  // No worktree or business-file writes; the executor enforces read-only mode.
  if (job.taskIntent === 'analysis') return realpath(repoPath);
  await run('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);

  const root = path.resolve(worktreeRoot);
  await mkdir(root, { recursive: true });
  // Reuse the approved mission's actual worktree, including uncommitted files.
  // Otherwise QA would test a fresh HEAD instead of the developer's changes.
  const previous = [...(job.context ?? [])].reverse().find((entry) => entry.result?.workspace)?.result.workspace;
  if (previous) {
    const candidate = await realpath(previous);
    const relative = path.relative(await realpath(root), candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Previous workspace is outside the Runner worktree root');
    const expected = await run('git', ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const actual = await run('git', ['-C', candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    if ((await realpath(expected.stdout.trim())) !== (await realpath(actual.stdout.trim()))) throw new Error('Previous workspace belongs to a different project');
    return candidate;
  }
  const target = path.join(root, sanitizeSegment(`${job.id}-${job.stage}`));
  try {
    await assertDirectory(target);
    return target;
  } catch {}

  await mkdir(worktreeRoot, { recursive: true });
  const branch = `codex/agentos-${sanitizeSegment(job.id)}-${sanitizeSegment(job.stage)}`;
  const baseBranch = project.baseBranch ?? 'main';
  try {
    await run('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, target, baseBranch]);
  } catch (error) {
    if (!String(error.message).includes('already exists')) throw error;
    await run('git', ['-C', repoPath, 'worktree', 'add', target, branch]);
  }
  return target;
}

export async function runVerification(commands, cwd, onOutput = () => {}) {
  const results = [];
  for (const command of commands ?? []) {
    const result = await runShell(command, cwd, onOutput);
    results.push({ command, ...result });
  }
  return results;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve({ code, stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)));
  });
}

function runShell(command, cwd, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => { const text = chunk.toString(); output += text; onOutput(text); });
    }
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve({ code, output: output.slice(-20_000) })
      : reject(new Error(`Verification failed (${code}): ${command}\n${output.slice(-4000)}`)));
  });
}

async function assertDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
}
