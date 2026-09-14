import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { prepareWorkspace } from '../src/runner/workspace.js';

const exec = promisify(execFile);
test('QA reuses developer worktree with uncommitted changes and rejects foreign paths', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-worktree-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo'), root = path.join(directory, 'trees');
  await mkdir(repo);
  const git = (...args) => exec('git', ['-C', repo, ...args], { windowsHide: true });
  await git('init');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  const project = { repoPath: repo, baseBranch: 'HEAD' };
  const workspace = await prepareWorkspace({ id: 'JOB-test', stage: 'developer', projectId: 'test' }, project, root);
  await writeFile(path.join(workspace, 'fix.txt'), 'actual uncommitted fix');
  const inherited = await prepareWorkspace({ id: 'JOB-qa', stage: 'qa', context: [{ result: { workspace } }] }, project, root);
  assert.equal(await readFile(path.join(inherited, 'fix.txt'), 'utf8'), 'actual uncommitted fix');
  await assert.rejects(prepareWorkspace({ id: 'bad', stage: 'qa', context: [{ result: { workspace: repo } }] }, project, root), /outside/);
  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  await exec('git', ['-C', foreign, 'init'], { windowsHide: true });
  await assert.rejects(prepareWorkspace({ id: 'bad', stage: 'qa', context: [{ result: { workspace: foreign } }] }, project, root), /different project/);
});
