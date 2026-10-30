import {parallelRead,prepareRepositoryLayers} from '../shared/parallel-read.js';
import {createHash,randomUUID} from 'node:crypto';
import {verifyIndependentGit} from '../shared/git-metadata.js';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { git, repositories } from './source-sync.js';
import {snapshotFailure, sourceGitError} from '../shared/source-git-diagnostic.js';
import { selectSourceEnvironment } from '../shared/source-environments.js';
const policy = 'isolated-environment-source-v1';
function within(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function independentObjects(cwd) {
  for (const name of ['alternates', 'http-alternates']) {
    const file = path.join(cwd, '.git', 'objects', 'info', name);
    const exists = await lstat(file).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new Error('源码快照仍依赖外部 Git 对象，未发布或复用');
  }
}
async function discardSeedHistory(cwd) {
  // Only the detached remote commit may remain reachable. Local-only refs,
  // reflogs and objects used to seed the transfer never become evidence.
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
  for (const ref of refs) await git(cwd, ['update-ref', '--no-deref', '-d', ref]);
  await git(cwd, ['reflog', 'expire', '--expire=now', '--all']);
  await git(cwd, ['repack', '-a', '-d']);
  await git(cwd, ['prune', '--expire=now']);
}
async function objectSeed(repo, snapshotRoot) {
  // A previous immutable cache is an object-transfer seed, never evidence or
  // an offline fallback. The real origin/branch has already been checked.
  try {
    await git(repo.cwd, ['cat-file', '-e', `${repo.commit}^{commit}`]);
    return repo.cwd;
  } catch { /* The requested environment may not exist in a shallow source. */ }
  const fullSource = await git(repo.cwd, ['rev-parse', '--is-shallow-repository']) === 'false';
  const candidates = [];
  for (const name of await readdir(snapshotRoot)) {
    if (!name.startsWith('analysis-')) continue;
    const container = path.join(snapshotRoot, name);
    try {
      const info = await lstat(container);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if((await lstat(container)).isSymbolicLink()||(await lstat(path.join(container,'source-manifest.json'))).isSymbolicLink())throw new Error('源码缓存清单路径异常');
  const manifest = JSON.parse(await readFile(path.join(container, 'source-manifest.json'), 'utf8'));
      const proof = manifest.repositories?.find(x => x.path === repo.path && x.branch === repo.branch);
      if (!proof || manifest.policy !== policy || !/^[a-f0-9]{40,64}$/.test(proof.commit)) continue;
      const workspace = path.join(container, 'workspace'), cwd = await realpath(path.resolve(workspace, repo.path));
      if ((cwd !== workspace && !within(workspace, cwd)) || !within(container, cwd)) continue;
      const gitDir = await lstat(path.join(cwd, '.git'));
      if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) continue;
      await independentObjects(cwd);
      if (await git(cwd, ['rev-parse', '--show-toplevel']) !== cwd || await git(cwd, ['rev-parse', 'HEAD']) !== proof.commit || await git(cwd, ['remote', 'get-url', 'origin']) !== repo.origin) continue;
      candidates.push({ cwd, exact: proof.commit === repo.commit, modified: info.mtimeMs });
    } catch { /* A damaged/unknown cache cannot seed another build. */ }
  }
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.modified - a.modified);
  if (!candidates[0]?.exact && fullSource) return repo.cwd;
  return candidates[0]?.cwd ?? repo.cwd;
}
async function canonicalMissingPath(file){
 let ancestor=path.resolve(file),suffix=[];
 for(;;){try{return path.join(await realpath(ancestor),...suffix.reverse());}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(ancestor);if(parent===ancestor)throw e;suffix.push(path.basename(ancestor));ancestor=parent;}}
}
async function settings(project, environment, {sourceOptional=false}={}) {
  if (project.analysisSourceMode !== 'isolated') throw new Error('独立分析配置已改变，请重新分析');
  const id = selectSourceEnvironment(project, environment);
  if (!project.analysisSnapshotRoot || !path.isAbsolute(project.analysisSnapshotRoot)) throw new Error('请配置绝对路径 analysisSnapshotRoot');
  const sourceRoot = await realpath(project.repoPath).catch(e=>{if(sourceOptional&&e.code==='ENOENT')return canonicalMissingPath(project.repoPath);throw e;});
  await mkdir(project.analysisSnapshotRoot, { recursive: true, mode: 0o700 });
  if((await lstat(project.analysisSnapshotRoot)).isSymbolicLink())throw new Error('源码缓存根目录不能是符号链接');
  const snapshotRoot = await realpath(project.analysisSnapshotRoot);
  if (snapshotRoot === sourceRoot || within(sourceRoot, snapshotRoot) || within(snapshotRoot, sourceRoot)) throw new Error('分析快照目录必须与个人项目目录分开');
  const repos = sourceOptional ? project.analysisEnvironments[id].repositories.map(r=>{if(typeof r.path!=='string'||path.isAbsolute(r.path)||r.path!=='.'&&r.path.split('/').some(p=>!p||p==='.'||p==='..')||typeof r.branch!=='string'||!r.branch||r.branch==='HEAD'||r.branch.startsWith('-'))throw new Error('源码仓库配置无效');return {...r,cwd:path.resolve(sourceRoot,r.path)};}) : await repositories({ ...project, analysisRepositories: project.analysisEnvironments[id].repositories });
  if(new Set(repos.map(r=>r.path)).size!==repos.length)throw new Error('源码仓库配置重复');
  repos.sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)));
  return { id, sourceRoot, snapshotRoot, repos };
}
// A branch may advance/roll back after ls-remote. Retain the first observed
// commit: fetch that exact object rather than silently choosing the new tip.
export async function fetchSnapshotCommit(cwd, repo, shallow, options = {}, run = git) {
 const flags = [...(shallow === 'true' ? ['--depth=1'] : []), '--no-tags', '--no-recurse-submodules', 'origin'];
 await run(cwd, ['fetch', ...flags, `refs/heads/${repo.branch}`], options);
 if (await run(cwd, ['rev-parse', 'FETCH_HEAD']) === repo.commit) return;
 await options.onBranchMoved?.();
 await run(cwd, ['fetch', ...flags, repo.commit], options);
 if (await run(cwd, ['rev-parse', 'FETCH_HEAD']) !== repo.commit) throw sourceGitError({code:'SOURCE_BRANCH_MOVED',operation:'fetch',retryable:false,attempts:1,exitCode:null});
}
export async function syncSnapshot(project, environment, {onProgress} = {}) {
 const prepared=await settings(project,environment);
 return withSnapshotLock(prepared.snapshotRoot,async(checkLock)=>{
  const {id,sourceRoot,snapshotRoot,repos}=prepared;
  const remote=await parallelRead(repos,async(repo)=>{
   let stage='读取来源配置';
   try{
    const origin=await git(repo.cwd,['remote','get-url','origin']);
    stage='核对远端分支';
    const lines=await git(repo.cwd,['ls-remote','origin',`refs/heads/${repo.branch}`], {onRetry: d => onProgress?.(`${repo.path}：远端核对暂时失败，正在重试第${d.nextAttempt}次（${d.code}）`)});
    const [commit,ref]=lines.split(/\s+/);
    if(!/^[a-f0-9]{40,64}$/.test(commit??'')||ref!==`refs/heads/${repo.branch}`)throw sourceGitError({code:'SOURCE_GIT_REMOTE_UNAVAILABLE',operation:'ls-remote',retryable:false,attempts:1,exitCode:null});
    return {...repo,origin,commit};
   }catch(error){throw snapshotFailure(repo,stage,error);}
  });
  const cacheKey=createHash('sha256').update(JSON.stringify([sourceRoot,id,remote.map(({path,branch,origin,commit})=>({path,branch,origin,commit}))])).digest('hex');
  const container=path.join(snapshotRoot,'analysis-'+cacheKey),remoteCheckedAt=new Date().toISOString();
  const existing=await lstat(container).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  let report;
  if(existing){
   if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('快照缓存路径异常，未复用');
   report=JSON.parse(await readFile(path.join(container,'source-manifest.json'),'utf8'));
   if(report.cacheKey!==cacheKey||report.environment!==id||report.sourceRoot!==sourceRoot||report.workspace!==path.join(container,'workspace')||JSON.stringify(report.repositories)!==JSON.stringify(remote.map(({path,branch,commit})=>({path,branch,commit}))))throw new Error('快照缓存身份不一致');
   await verifySnapshotUnlocked(project,report);
  }else{
   const temporary=await mkdtemp(path.join(snapshotRoot,'building-'));
   const workspace=path.join(temporary,'workspace');await mkdir(workspace,{mode:0o700});
   report={policy,cacheKey,projectId:project.id??null,repositorySources:remote.map(r=>({path:r.path,originHash:createHash('sha256').update(r.origin).digest('hex')})),environment:id,sourceRoot,workspace:path.join(container,'workspace'),checkedAt:remoteCheckedAt,repositories:[]};
   try{
    await writeFile(path.join(temporary,'build-owner.json'),JSON.stringify({policy:'snapshot-build-v1',sourceRoot,environment:id}),{mode:0o600,flag:'wx'});
    report.repositories=await prepareRepositoryLayers(remote,async(repo,index)=>{
     await onProgress?.(`正在准备源码 ${index+1}/${remote.length}：${repo.path}（${repo.branch}）`);
     let stage='检查缓存路径';
     try{
     const target=path.resolve(workspace,repo.path);let ancestor=workspace;
     for(const part of path.relative(workspace,target).split(path.sep).filter(Boolean)){
      ancestor=path.join(ancestor,part);const info=await lstat(ancestor).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(info?.isSymbolicLink())throw new Error('快照路径包含符号链接');
     }
     await mkdir(target,{recursive:true});
     if((target!==workspace&&!within(workspace,await realpath(target)))||(await readdir(target)).length)throw new Error(`快照路径冲突：${repo.path}`);
     stage='选择对象种子';
      // Independently copy local objects (including a shallow boundary), then
      // let the real origin supply and select the requested environment tip.
      // Never copy the personal index/worktree or depend on shared objects.
      const seed=await objectSeed(repo,snapshotRoot);
      stage='复制本机Git对象';
      await git(workspace,['clone','--local','--no-hardlinks','--dissociate','--no-checkout','--no-tags','--',seed,target]);
      stage='准备独立Git元数据';
      await git(target,['remote','set-url','origin',repo.origin]);
      // Detached caches have no refs. Advertise their copied objects during
      // fetch negotiation; discard this temporary ref before publication.
      const seedHead=await git(target,['rev-parse','--verify','HEAD']).catch(()=>null);
      if(seedHead)await git(target,['update-ref','refs/heads/agentos-object-seed',seedHead]);
      const shallow=await git(seed,['rev-parse','--is-shallow-repository']);
      stage='下载固定版本';
      await fetchSnapshotCommit(target,repo,shallow,{
       onRetry: d => onProgress?.(`${repo.path}：源码下载暂时失败，正在重试第${d.nextAttempt}次（${d.code}）`),
       onBranchMoved: () => onProgress?.(`${repo.path}：分支在同步期间变化，继续获取首次核对的固定提交，不切换版本`),
      });
      stage='核对对象独立性';
      await independentObjects(target);
      stage='检出固定提交';
      await git(target,['checkout','--detach',repo.commit]);
      stage='整理临时缓存对象';
      await discardSeedHistory(target);
      return {path:repo.path,branch:repo.branch,commit:repo.commit};
     }catch(error){throw snapshotFailure(repo,stage,error);}
    });
    await writeFile(path.join(temporary,'source-manifest.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});
    checkLock();await rename(temporary,container);
   }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
   await verifySnapshotUnlocked(project,report);
  }
  const pointer=path.join(snapshotRoot,'latest-'+createHash('sha256').update(id).digest('hex').slice(0,32)+'.json');
  const tmp=pointer+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({environment:id,container:path.basename(container),remoteCheckedAt}),{mode:0o600,flag:'wx'});checkLock();await rename(tmp,pointer);
  return {...report,remoteCheckedAt};
 });
}
async function verifySnapshotUnlocked(project, report) {
  const { id, sourceRoot, snapshotRoot, repos } = await settings(project, report.environment,{sourceOptional:true});
  if((await lstat(report.workspace)).isSymbolicLink())throw new Error('源码缓存工作区不能是符号链接');
  const workspace = await realpath(report.workspace);
  const container = path.dirname(workspace);
  if (!within(snapshotRoot, container) || path.dirname(container) !== snapshotRoot || path.basename(workspace) !== 'workspace' || report.sourceRoot !== sourceRoot || report.environment !== id) throw new Error('快照证据路径或环境不匹配');
  if((await lstat(container)).isSymbolicLink()||(await lstat(path.join(container,'source-manifest.json'))).isSymbolicLink())throw new Error('源码缓存清单路径异常');
  const manifest = JSON.parse(await readFile(path.join(container, 'source-manifest.json'), 'utf8'));
  const {remoteCheckedAt,...immutable}=report;
  if (JSON.stringify(manifest) !== JSON.stringify(immutable) || report.repositories.length !== repos.length) throw new Error('源码快照清单与任务证据不匹配');
  for (const repo of repos) {
    const cwd = await realpath(path.resolve(workspace, repo.path));
    if (cwd !== workspace && !within(workspace, cwd)) throw new Error('源码快照路径越界');
    await independentObjects(cwd);
    await verifyIndependentGit(cwd);
    const proof = report.repositories.find(x => x.path === repo.path && x.branch === repo.branch);
    if (!proof || await git(cwd, ['rev-parse', '--show-toplevel']) !== cwd || await git(cwd, ['rev-parse', 'HEAD']) !== proof.commit) throw new Error('源码已不同于本次分析快照');
    // Independently cloned child repositories are verified below, not untracked dirt in their parent.
    const children = repos.filter(x => x.path !== repo.path && within(cwd, path.resolve(workspace, x.path))).map(x => `:(exclude)${path.relative(cwd, path.resolve(workspace, x.path))}`);
    if (await git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...children])) throw new Error('源码快照存在本地修改，请重新分析');
  }
  return report;
}

export async function verifySnapshot(project,report){
 const prepared=await settings(project,report.environment,{sourceOptional:true});
 return withSnapshotLock(prepared.snapshotRoot,async check=>{check();const result=await verifySnapshotUnlocked(project,report);check();return result;});
}

// Explicit repository selection avoids downloading every system's ancestry for
// simple current-file questions. Only the pinned commit is fetched, never tip.
export async function prepareSnapshotHistory(project,report,{repositories:requested=report.repositories.map(r=>r.path)}={}){
 const prepared=await settings(project,report.environment,{sourceOptional:true});
 if(!Array.isArray(requested)||!requested.length||new Set(requested).size!==requested.length||requested.some(p=>!report.repositories.some(r=>r.path===p)))throw new Error('历史请求只能选择当前问题快照内的明确仓库');
 return withSnapshotLock(prepared.snapshotRoot,async check=>{
  await verifySnapshotUnlocked(project,report);const results=[];
  for(const proof of report.repositories.filter(r=>requested.includes(r.path))){
   const cwd=path.resolve(report.workspace,proof.path);
   try{
    await verifyIndependentGit(cwd);check();
    const actual=await git(cwd,['remote','get-url','origin']);
    const fingerprint=report.repositorySources?.find(r=>r.path===proof.path)?.originHash;
    if(fingerprint&&fingerprint!==createHash('sha256').update(actual).digest('hex'))throw new Error('仓库来源变化，未补取其它来源历史');
    const configured=prepared.repos.find(r=>r.path===proof.path&&r.branch===proof.branch);
    const origin=await git(configured.cwd,['remote','get-url','origin']).catch(()=>null);
    if(origin&&origin!==actual)throw new Error('配置仓库来源变化，未补取其它来源历史');
    const wasShallow=await git(cwd,['rev-parse','--is-shallow-repository'])==='true';
    if(wasShallow){
     if(!origin)throw new Error('来源仓库不可用；当前源码保留，尚未补取祖先历史');
     await git(cwd,['fetch','--unshallow','--no-tags','--no-recurse-submodules','origin',proof.commit]);
    }
    check();await verifyIndependentGit(cwd);
    if(await git(cwd,['rev-parse','--is-shallow-repository'])!=='false')throw new Error('上游仍为浅仓，祖先历史不完整');
    await git(cwd,['rev-list','--objects','--missing=error','--quiet',proof.commit]);
    const commits=Number(await git(cwd,['rev-list','--count',proof.commit]));
    results.push({...proof,status:'complete',scope:'fixed-commit-ancestors',commits,reused:!wasShallow,checkedAt:new Date().toISOString()});
   }catch(error){results.push({...proof,status:'unavailable',code:error.code??'SOURCE_HISTORY_UNAVAILABLE',reason:error.message,recovery:'恢复原来源/认证后重试同一固定提交；当前源码证据仍保留，不切换版本。'});}
  }
  check();await verifySnapshotUnlocked(project,report);
  return {policy:'pinned-source-ancestry-v1',environment:report.environment,repositories:results,deploymentVerified:false};
 });
}

export async function restoreSnapshot(project,report){
 const prepared=await settings(project,report.environment);
 return withSnapshotLock(prepared.snapshotRoot,async(checkLock)=>{
  const {snapshotRoot,sourceRoot,repos,id}=prepared,container=path.dirname(report.workspace);
  if(path.dirname(container)!==snapshotRoot||path.basename(report.workspace)!=='workspace'||report.sourceRoot!==sourceRoot||!/^analysis-[A-Za-z0-9]+$/.test(path.basename(container)))throw new Error('历史源码缓存路径不匹配');
  if(await lstat(container).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}))return verifySnapshotUnlocked(project,report);
  let audit;
  try{const dir=path.join(snapshotRoot,'.snapshot-audit');if((await lstat(dir)).isSymbolicLink())throw new Error();const file=path.join(dir,path.basename(container)+'.json');if((await lstat(file)).isSymbolicLink())throw new Error();audit=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('历史源码缓存已不可用且没有可信提交清单；请恢复原快照，或明确新建问题核对最新版本。未切换提交。');}
  const {remoteCheckedAt,...immutable}=report;
  if(audit.policy!=='source-cache-reclamation-v1'||JSON.stringify(audit.manifest)!==JSON.stringify(immutable))throw new Error('历史源码清理清单与原任务不匹配；未切换提交');
  const tmp=await mkdtemp(path.join(snapshotRoot,'building-'));
  try{
   await writeFile(path.join(tmp,'build-owner.json'),JSON.stringify({policy:'snapshot-build-v1',sourceRoot,environment:id}),{mode:0o600});
   const workspace=path.join(tmp,'workspace');await mkdir(workspace);
   if(repos.length!==report.repositories.length)throw new Error('仓库配置已变化');
   for(const repo of repos){
    const proof=report.repositories.find(r=>r.path===repo.path&&r.branch===repo.branch),origin=await git(repo.cwd,['remote','get-url','origin']);
    const source=audit.repositorySources.find(r=>r.path===repo.path);
    if(!proof||!source||source.originHash!==createHash('sha256').update(origin).digest('hex'))throw new Error('仓库来源已变化');
    const target=path.resolve(workspace,repo.path);if(target!==workspace&&!within(workspace,target))throw new Error('仓库路径越界');
    let ancestor=workspace;for(const part of path.relative(workspace,target).split(path.sep).filter(Boolean)){ancestor=path.join(ancestor,part);if((await lstat(ancestor).catch(()=>null))?.isSymbolicLink())throw new Error('仓库路径包含符号链接');}
    await mkdir(target,{recursive:true});if((await readdir(target)).length)throw new Error('仓库路径冲突');
    const seed=await objectSeed({...repo,origin,commit:proof.commit},snapshotRoot);
    await git(workspace,['clone','--local','--no-hardlinks','--dissociate','--no-checkout','--no-tags','--',seed,target]);await git(target,['remote','set-url','origin',origin]);
    const head=await git(target,['rev-parse','--verify','HEAD']).catch(()=>null);if(head)await git(target,['update-ref','refs/heads/agentos-object-seed',head]);
    const shallow=await git(seed,['rev-parse','--is-shallow-repository']);
    checkLock();await git(target,['fetch',...(shallow==='true'?['--depth=1']:[]),'--no-tags','--no-recurse-submodules','origin',proof.commit]);
    if(await git(target,['rev-parse','FETCH_HEAD'])!==proof.commit)throw new Error('提交不一致');await git(target,['checkout','--detach',proof.commit]);await discardSeedHistory(target);await verifyIndependentGit(target);
   }
   await writeFile(path.join(tmp,'source-manifest.json'),JSON.stringify(immutable),{mode:0o600});checkLock();await rename(tmp,container);return await verifySnapshotUnlocked(project,report);
  }catch{await rm(tmp,{recursive:true,force:true});throw new Error('历史源码缓存恢复失败：原提交或仓库来源不可用。请维护者恢复原提交后继续，或明确新建问题核对最新版本；没有改用旧缓存或其它提交。');}
 });
}
