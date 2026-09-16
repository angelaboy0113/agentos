import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, repositories } from './source-sync.js';
import { selectSourceEnvironment } from '../shared/source-environments.js';
const policy = 'isolated-environment-source-v1';
function within(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function settings(project, environment) {
  if (project.analysisSourceMode !== 'isolated') throw new Error('独立分析配置已改变，请重新分析');
  const id = selectSourceEnvironment(project, environment);
  if (!project.analysisSnapshotRoot || !path.isAbsolute(project.analysisSnapshotRoot)) throw new Error('请配置绝对路径 analysisSnapshotRoot');
  const sourceRoot = await realpath(project.repoPath);
  await mkdir(project.analysisSnapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotRoot = await realpath(project.analysisSnapshotRoot);
  if (snapshotRoot === sourceRoot || within(sourceRoot, snapshotRoot) || within(snapshotRoot, sourceRoot)) throw new Error('分析快照目录必须与个人项目目录分开');
  const repos = await repositories({ ...project, analysisRepositories: project.analysisEnvironments[id].repositories });
  repos.sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)));
  return { id, sourceRoot, snapshotRoot, repos };
}
export async function syncSnapshot(project, environment) {
  const { id, sourceRoot, snapshotRoot, repos } = await settings(project, environment);
  const container = await mkdtemp(path.join(snapshotRoot, 'analysis-'));
  const workspace = path.join(container, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  const report = { policy, environment: id, sourceRoot, workspace, checkedAt: null, repositories: [] };
  for (const repo of repos) {
    const target = path.resolve(workspace, repo.path);
    let ancestor = workspace;
    for (const part of path.relative(workspace, target).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      const info = await lstat(ancestor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info?.isSymbolicLink()) throw new Error('快照路径包含符号链接');
    }
    await mkdir(target, { recursive: true });
    if ((target !== workspace && !within(workspace, await realpath(target))) || (await readdir(target)).length) throw new Error(`快照路径冲突：${repo.path}`);
    // Read origin only; never fetch, checkout, stash or reset in the personal checkout.
    const origin = await git(repo.cwd, ['remote', 'get-url', 'origin']);
    try {
      await git(target, ['init']);
      await git(target, ['remote', 'add', 'origin', origin]);
      await git(target, ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${repo.branch}`]);
      const commit = await git(target, ['rev-parse', 'FETCH_HEAD']);
      await git(target, ['checkout', '--detach', commit]);
      report.repositories.push({ path: repo.path, branch: repo.branch, commit });
    } catch { throw new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；请检查 origin 分支、网络与本机登录。个人开发目录未被同步或切换。`); }
  }
  report.checkedAt = new Date().toISOString();
  await writeFile(path.join(container, 'source-manifest.json'), JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  return verifySnapshot(project, report);
}
export async function verifySnapshot(project, report) {
  const { id, sourceRoot, snapshotRoot, repos } = await settings(project, report.environment);
  const workspace = await realpath(report.workspace);
  const container = path.dirname(workspace);
  if (!within(snapshotRoot, container) || path.dirname(container) !== snapshotRoot || path.basename(workspace) !== 'workspace' || report.sourceRoot !== sourceRoot || report.environment !== id) throw new Error('快照证据路径或环境不匹配');
  const manifest = JSON.parse(await readFile(path.join(container, 'source-manifest.json'), 'utf8'));
  if (JSON.stringify(manifest) !== JSON.stringify(report) || report.repositories.length !== repos.length) throw new Error('源码快照清单与任务证据不匹配');
  for (const repo of repos) {
    const cwd = await realpath(path.resolve(workspace, repo.path));
    if (cwd !== workspace && !within(workspace, cwd)) throw new Error('源码快照路径越界');
    const proof = report.repositories.find(x => x.path === repo.path && x.branch === repo.branch);
    if (!proof || await git(cwd, ['rev-parse', '--show-toplevel']) !== cwd || await git(cwd, ['rev-parse', 'HEAD']) !== proof.commit) throw new Error('源码已不同于本次分析快照');
    // Independently cloned child repositories are verified below, not untracked dirt in their parent.
    const children = repos.filter(x => x.path !== repo.path && within(cwd, path.resolve(workspace, x.path))).map(x => `:(exclude)${path.relative(cwd, path.resolve(workspace, x.path))}`);
    if (await git(cwd, ['status', '--porcelain', '--untracked-files=normal', '--', '.', ...children])) throw new Error('源码快照存在本地修改，请重新分析');
  }
  return report;
}
