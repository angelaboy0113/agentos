import {createHash,randomUUID} from 'node:crypto';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, lstat, rename, rm } from 'node:fs/promises';
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
 const prepared=await settings(project,environment);
 return withSnapshotLock(prepared.snapshotRoot,async()=>{
  const {id,sourceRoot,snapshotRoot,repos}=prepared;
  const remote=[];
  for(const repo of repos){
   try{
    const origin=await git(repo.cwd,['remote','get-url','origin']);
    const lines=await git(repo.cwd,['ls-remote','origin',`refs/heads/${repo.branch}`]);
    const [commit,ref]=lines.split(/\s+/);
    if(!/^[a-f0-9]{40,64}$/.test(commit??'')||ref!==`refs/heads/${repo.branch}`)throw new Error();
    remote.push({...repo,origin,commit});
   }catch{throw new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；远端分支不可用，未回退到旧缓存或其它环境。`);}
  }
  const cacheKey=createHash('sha256').update(JSON.stringify([sourceRoot,id,remote.map(({path,branch,origin,commit})=>({path,branch,origin,commit}))])).digest('hex');
  const container=path.join(snapshotRoot,'analysis-'+cacheKey),remoteCheckedAt=new Date().toISOString();
  const existing=await lstat(container).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  let report;
  if(existing){
   if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('快照缓存路径异常，未复用');
   report=JSON.parse(await readFile(path.join(container,'source-manifest.json'),'utf8'));
   if(report.cacheKey!==cacheKey||report.environment!==id||report.sourceRoot!==sourceRoot||report.workspace!==path.join(container,'workspace')||JSON.stringify(report.repositories)!==JSON.stringify(remote.map(({path,branch,commit})=>({path,branch,commit}))))throw new Error('快照缓存身份不一致');
   await verifySnapshot(project,report);
  }else{
   const temporary=await mkdtemp(path.join(snapshotRoot,'building-'));
   const workspace=path.join(temporary,'workspace');await mkdir(workspace,{mode:0o700});
   report={policy,cacheKey,environment:id,sourceRoot,workspace:path.join(container,'workspace'),checkedAt:remoteCheckedAt,repositories:[]};
   try{
    await writeFile(path.join(temporary,'build-owner.json'),JSON.stringify({policy:'snapshot-build-v1',sourceRoot,environment:id}),{mode:0o600,flag:'wx'});
    for(const repo of remote){
     const target=path.resolve(workspace,repo.path);let ancestor=workspace;
     for(const part of path.relative(workspace,target).split(path.sep).filter(Boolean)){
      ancestor=path.join(ancestor,part);const info=await lstat(ancestor).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(info?.isSymbolicLink())throw new Error('快照路径包含符号链接');
     }
     await mkdir(target,{recursive:true});
     if((target!==workspace&&!within(workspace,await realpath(target)))||(await readdir(target)).length)throw new Error(`快照路径冲突：${repo.path}`);
     try{
      await git(target,['init']);await git(target,['remote','add','origin',repo.origin]);
      await git(target,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',`refs/heads/${repo.branch}`]);
      if(await git(target,['rev-parse','FETCH_HEAD'])!==repo.commit)throw new Error();
      await git(target,['checkout','--detach',repo.commit]);
      report.repositories.push({path:repo.path,branch:repo.branch,commit:repo.commit});
     }catch{throw new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；远端可能在同步中变化，请重新核对。未覆盖旧快照或个人源码。`);}
    }
    await writeFile(path.join(temporary,'source-manifest.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});
    await rename(temporary,container);
   }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
   await verifySnapshot(project,report);
  }
  const pointer=path.join(snapshotRoot,'latest-'+createHash('sha256').update(id).digest('hex').slice(0,32)+'.json');
  const tmp=pointer+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({environment:id,container:path.basename(container),remoteCheckedAt}),{mode:0o600,flag:'wx'});await rename(tmp,pointer);
  return {...report,remoteCheckedAt};
 });
}
export async function verifySnapshot(project, report) {
  const { id, sourceRoot, snapshotRoot, repos } = await settings(project, report.environment);
  const workspace = await realpath(report.workspace);
  const container = path.dirname(workspace);
  if (!within(snapshotRoot, container) || path.dirname(container) !== snapshotRoot || path.basename(workspace) !== 'workspace' || report.sourceRoot !== sourceRoot || report.environment !== id) throw new Error('快照证据路径或环境不匹配');
  const manifest = JSON.parse(await readFile(path.join(container, 'source-manifest.json'), 'utf8'));
  const {remoteCheckedAt,...immutable}=report;
  if (JSON.stringify(manifest) !== JSON.stringify(immutable) || report.repositories.length !== repos.length) throw new Error('源码快照清单与任务证据不匹配');
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
