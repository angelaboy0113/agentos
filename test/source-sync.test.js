import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { syncAnalysisSources, verifyAnalysisSources, prepareAnalysisSources } from '../src/runner/source-sync.js';
import { executeJob, buildPrompt, buildCodexArgs } from '../src/runner/codex-executor.js';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
async function commit(cwd, value) {
  await writeFile(path.join(cwd, 'source.txt'), value);
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', value);
}
async function fixture(t, name = 'business', branch = 'business-main') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agentos-source-sync-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace'), origin = path.join(base, 'origin.git'), writer = path.join(base, 'writer');
  await mkdir(root); await mkdir(writer);
  await git(base, 'init', '--bare', origin);
  await git(writer, 'init', '-b', branch); await commit(writer, 'old');
  await git(writer, 'remote', 'add', 'origin', origin); await git(writer, 'push', '-u', 'origin', branch);
  const repo = path.join(root, name);
  await git(base, 'clone', '-b', branch, origin, repo);
  return { base, root, origin, writer, repo, branch, project: { repoPath: root, analysisRepositories: [{ path: name, branch }] } };
}
test('sync advances clean checkout to explicit origin branch, records proof, and report never fetches again', async (t) => {
  const f = await fixture(t);
  await commit(f.writer, 'new'); await git(f.writer, 'push');
  const report = await syncAnalysisSources(f.project);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'new');
  assert.equal(report.repositories[0].changed, true);
  assert.equal(report.repositories[0].commit, await git(f.writer, 'rev-parse', 'HEAD'));
  assert.ok(report.checkedAt);
  await git(f.repo, 'remote', 'set-url', 'origin', path.join(f.base, 'unavailable'));
  assert.deepEqual(await prepareAnalysisSources({ stage: 'owner_report', context: [{ result: { sourceSync: report } }] }, f.project), report);
  await writeFile(path.join(f.repo, 'source.txt'), 'changed during analysis');
  await assert.rejects(verifyAnalysisSources(f.project, report), /本地修改/);
});
test('dirty, wrong branch, detached, ahead and diverged checkouts cannot be analyzed or overwritten', async (t) => {
  const f = await fixture(t), initial = await git(f.repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.repo, 'untracked.txt'), 'keep');
  await assert.rejects(syncAnalysisSources(f.project), /本地修改/);
  assert.equal(await readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep');
  await rm(path.join(f.repo, 'untracked.txt'));
  await git(f.repo, 'checkout', '-b', 'other');
  await assert.rejects(syncAnalysisSources(f.project), /当前分支/);
  await git(f.repo, 'checkout', '--detach');
  await assert.rejects(syncAnalysisSources(f.project), /当前分支/);
  await git(f.repo, 'checkout', f.branch);
  await commit(f.repo, 'local only');
  await assert.rejects(syncAnalysisSources(f.project), /未推送提交/);
  await commit(f.writer, 'remote edit'); await git(f.writer, 'push');
  await assert.rejects(syncAnalysisSources(f.project), /分叉/);
  assert.notEqual(await git(f.repo, 'rev-parse', 'HEAD'), initial);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'local only');
});
test('all repositories are preflighted before any checkout advances; independent branches stay independent', async (t) => {
  const f = await fixture(t), second = path.join(f.root, 'second');
  await git(f.writer, 'checkout', '-b', 'second-main'); await commit(f.writer, 'second'); await git(f.writer, 'push', '-u', 'origin', 'second-main');
  await git(f.base, 'clone', '-b', 'second-main', f.origin, second);
  f.project.analysisRepositories.push({ path: 'second', branch: 'second-main' });
  await git(f.writer, 'checkout', f.branch); await commit(f.writer, 'new first'); await git(f.writer, 'push', 'origin', f.branch);
  await writeFile(path.join(second, 'untracked'), 'keep');
  await assert.rejects(syncAnalysisSources(f.project), /本地修改/);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'old');
  await rm(path.join(second, 'untracked'));
  const report = await syncAnalysisSources(f.project);
  assert.deepEqual(report.repositories.map(r => r.branch), [f.branch, 'second-main']);
  assert.equal(await readFile(path.join(second, 'source.txt'), 'utf8'), 'second');
});
test('missing configuration, missing remote branch, paths outside root and duplicates fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(syncAnalysisSources({ repoPath: f.root }), /analysisRepositories/);
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [{ path: '../writer', branch: f.branch }] }), /越界/);
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [...f.project.analysisRepositories, ...f.project.analysisRepositories] }), /重复/);
  await git(f.repo, 'checkout', '-b', 'missing-on-origin');
  f.project.analysisRepositories[0].branch = 'missing-on-origin';
  await assert.rejects(syncAnalysisSources(f.project), /Git 操作失败/);
});
test('fetch errors with credential-bearing remote never expose URL or token', async (t) => {
  const f = await fixture(t);
  await git(f.repo, 'remote', 'set-url', 'origin', 'https://hidden:secret@127.0.0.1:1/no.git');
  await assert.rejects(syncAnalysisSources(f.project), error => !/hidden|secret|127\.0\.0\.1/.test(error.message));
});
test('executeJob blocks before starting Codex when sync config is absent; read-only permission remains', async () => {
  const result = await executeJob({ taskIntent: 'analysis', stage: 'developer', projectId: 'demo' }, {
    executor: 'codex', codexBin: '/must-not-start', projects: { demo: {} },
  }, async () => {});
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.sourceSyncBlocked, true);
  assert.match(result.finalMessage, /analysisRepositories/);
  const args = buildCodexArgs('/tmp', [], { readOnly: true });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  const evidence = { policy: 'origin-ff-before-analysis-v1', repositories: [{ path: '.', branch: 'main', commit: 'abc' }] };
  const prompt = await buildPrompt({ taskIntent: 'analysis' }, {}, { instruction: '', metadata: {} }, evidence);
  assert.match(prompt, /"commit":"abc"/);
});

test('unfinished Git operation, symlink escape and changed committed evidence are rejected', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, '.git', 'CHERRY_PICK_HEAD'), await git(f.repo, 'rev-parse', 'HEAD'));
  await assert.rejects(syncAnalysisSources(f.project), /未结束/);
  await rm(path.join(f.repo, '.git', 'CHERRY_PICK_HEAD'));
  await symlink(f.writer, path.join(f.root, 'outside'), 'junction');
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [{ path: 'outside', branch: f.branch }] }), /越界/);
  const report = await syncAnalysisSources(f.project);
  await commit(f.repo, 'later commit');
  await assert.rejects(verifyAnalysisSources(f.project, report), /不同于/);
  await assert.rejects(prepareAnalysisSources({ stage: 'owner_report', context: [] }, f.project), /缺少本次/);
});
