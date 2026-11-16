import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat,realpath} from 'node:fs/promises';
import {git} from './source-sync.js';
import {verifySnapshot} from './source-snapshot.js';
import {verifyIndependentGit} from '../shared/git-metadata.js';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import {documentDirectory} from '../shared/document-artifacts.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function directory(p){await mkdir(p,{recursive:true,mode:0o700});const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(p)!==p)throw Error('Reference cache boundary invalid');}
// A separately labelled source reference can explain a missing symbol. It is never a replacement environment snapshot.
export async function prepareSourceReference(project,sync,query,{job,dataDir,run=git,verify=verifySnapshot}={}){
 if(job?.taskIntent!=='analysis'||sync?.policy!=='isolated-environment-source-v1'||!['list_branches','read_branch','reference_history'].includes(query.operation)||typeof query.reason!=='string'||!query.reason.trim())throw Error('Invalid source reference request');
 const repo=sync.repositories.find(r=>r.path===query.repository);if(!repo)throw Error('Source reference repository is outside the original scope');
 await verify(project,sync);
 const source=path.resolve(sync.workspace,repo.path);await verifyIndependentGit(source);
 const origin=await run(source,['remote','get-url','origin']);
 if(query.operation==='reference_history')return hydrateSourceReference(project,sync,query,{job,dataDir,run,verify,origin});
 const raw=await run(source,['ls-remote','--heads','origin']);
 const branches=raw.split('\n').filter(Boolean).map(l=>{const[commit,ref]=l.split(/\s+/);if(!/^[a-f0-9]{40,64}$/.test(commit)||!ref?.startsWith('refs/heads/'))throw Error('Invalid remote branch response');return{branch:ref.slice(11),commit};});
 if(new Set(branches.map(r=>r.branch)).size!==branches.length)throw Error('Duplicate remote branch response');
 const binding={jobId:job.id,questionId:job.questionId,profile:job.originProfile??job.agentProfile,projectId:job.projectId,environment:sync.environment,repository:repo.path,originalCommit:repo.commit,originalCacheKey:sync.cacheKey};
 const base={policy:'separate-source-reference-v1',binding,checkedAt:new Date().toISOString(),deploymentVerified:false,environmentSnapshotUnchanged:true};
 if(query.operation==='list_branches')return{...base,branches,complete:true};
 if(typeof query.branch!=='string'||!query.branch||query.branch.startsWith('-'))throw Error('Invalid source reference branch');
 await run(source,['check-ref-format','refs/heads/'+query.branch]);
 const target=branches.find(r=>r.branch===query.branch);if(!target)throw Error('Requested reference branch is not on the current authorized origin');
 const parent=path.join(await documentDirectory(dataDir,job.id),'source-references');await directory(parent);
 const key=digest([binding,origin,target]),container=path.join(parent,key);
 return withSnapshotLock(parent,async()=>{
  const report={...base,branch:target.branch,commit:target.commit,workspace:path.join(container,'workspace'),originHash:digest(origin)};
  let exists;try{exists=await lstat(container);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(exists){
   if(exists.isSymbolicLink()||!exists.isDirectory()||await realpath(container)!==container)throw Error('Invalid cached reference boundary');
   const manifest=path.join(container,'reference.json'),info=await lstat(manifest);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(manifest)!==manifest)throw Error('Reference manifest boundary invalid');
   const saved=JSON.parse(await readFile(manifest,'utf8'));
   if(digest(saved.binding)!==digest(binding)||saved.commit!==target.commit||saved.branch!==target.branch||saved.originHash!==report.originHash||saved.workspace!==report.workspace)throw Error('Cached reference identity mismatch');
   await verifyIndependentGit(saved.workspace);
   if(await run(saved.workspace,['rev-parse','HEAD'])!==target.commit||await run(saved.workspace,['status','--porcelain','--untracked-files=all']))throw Error('Cached reference content changed');
   return{...saved,checkedAt:report.checkedAt,reused:true};
  }
  const temp=path.join(parent,'building-'+randomUUID()),workspace=path.join(temp,'workspace');await directory(workspace);
  try{
   await run(workspace,['init']);await verifyIndependentGit(workspace);await run(workspace,['remote','add','origin',origin]);
   // Fetch the first observed SHA directly: a moving branch must not change the evidence mid-investigation.
   await run(workspace,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',target.commit]);
   if(await run(workspace,['rev-parse','FETCH_HEAD'])!==target.commit)throw Error('Reference commit mismatch');
   const tree=await run(workspace,['ls-tree','-r',target.commit]);if(tree.split('\n').some(l=>/^(120000|160000) /.test(l)))throw Error('Reference has symlinks or submodules; not materialized outside reviewed boundaries');
   await verifyIndependentGit(workspace);await run(workspace,['checkout','--detach',target.commit]);await verifyIndependentGit(workspace);
   if(await run(workspace,['status','--porcelain','--untracked-files=all']))throw Error('Reference tree is not clean');
   await writeFile(path.join(temp,'reference.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});await rename(temp,container);return{...report,reused:false};
  }catch(e){await rm(temp,{recursive:true,force:true});throw e;}
 });
}

export async function sourceReferenceArtifact(dataDir,job,relative){
 const match=/^source-references\/([a-f0-9]{64})\/workspace\/(.+)$/.exec(relative??'');if(!match)throw Error('Invalid reference artifact path');
 const scope=job.sourceReferenceScope;if(scope?.policy!=='isolated-environment-source-v1')throw Error('Missing trusted original source scope');
 const container=path.join(await documentDirectory(dataDir,job.id),'source-references',match[1]),manifest=path.join(container,'reference.json');
 for(const p of [path.dirname(container),container,manifest]){const s=await lstat(p);if(s.isSymbolicLink()||await realpath(p)!==p||s.isFile()&&s.nlink!==1)throw Error('Reference artifact boundary invalid');}
 const ref=JSON.parse(await readFile(manifest,'utf8')),b=ref.binding,original=scope.repositories.find(r=>r.path===b?.repository);
 if(ref.policy!=='separate-source-reference-v1'||b.jobId!==job.id||b.questionId!==job.questionId||b.profile!==(job.originProfile??job.agentProfile)||b.projectId!==job.projectId||b.environment!==scope.environment||b.originalCacheKey!==scope.cacheKey||original?.commit!==b.originalCommit||ref.workspace!==path.join(container,'workspace')||!/^[a-f0-9]{40,64}$/.test(ref.commit))throw Error('Reference artifact identity mismatch');
 await verifyIndependentGit(ref.workspace);
 const file=path.join(ref.workspace,match[2]);if(await realpath(file)!==file)throw Error('Linked reference file');const info=await lstat(file);if(!info.isFile()||info.nlink!==1)throw Error('Invalid reference file');
 if(await git(ref.workspace,['rev-parse','HEAD'])!==ref.commit||await git(ref.workspace,['remote','get-url','origin']).then(origin=>digest(origin))!==ref.originHash||await git(ref.workspace,['rev-parse',ref.commit+':'+match[2]])!==await git(ref.workspace,['hash-object','--',match[2]]))throw Error('Reference file differs from the fixed commit');
 return{file,bytes:info.size,branch:ref.branch,commit:ref.commit,repository:b.repository,environmentSnapshotUnchanged:true,deploymentVerified:false};
}

// Hydrate only an already materialized, receipt-bound reference. A new remote tip
// cannot replace its fixed commit, and no model-provided directory is accepted.
async function hydrateSourceReference(project,sync,query,{job,dataDir,run,verify,origin}){
 if(typeof query.branch!=='string'||!query.branch||!/^[a-f0-9]{40,64}$/.test(query.commit??''))throw Error('Reference history requires its exact branch and fixed commit');
 const repo=sync.repositories.find(r=>r.path===query.repository),binding={jobId:job.id,questionId:job.questionId,profile:job.originProfile??job.agentProfile,projectId:job.projectId,environment:sync.environment,repository:repo.path,originalCommit:repo.commit,originalCacheKey:sync.cacheKey};
 const parent=path.join(await documentDirectory(dataDir,job.id),'source-references');await directory(parent);
 const container=path.join(parent,digest([binding,origin,{branch:query.branch,commit:query.commit}])),workspace=path.join(container,'workspace');
 return withSnapshotLock(parent,async check=>{
  for(const p of [container,workspace,path.join(container,'reference.json')]){const st=await lstat(p);if(st.isSymbolicLink()||await realpath(p)!==p||st.isFile()&&st.nlink!==1)throw Error('Reference history boundary invalid');}
  const saved=JSON.parse(await readFile(path.join(container,'reference.json'),'utf8'));
  if(saved.policy!=='separate-source-reference-v1'||digest(saved.binding)!==digest(binding)||saved.branch!==query.branch||saved.commit!==query.commit||saved.workspace!==workspace||saved.originHash!==digest(origin))throw Error('Reference history receipt mismatch');
  const inspect=async()=>{await verifyIndependentGit(workspace);if(await run(workspace,['rev-parse','HEAD'])!==saved.commit||await run(workspace,['remote','get-url','origin'])!==origin||await run(workspace,['status','--porcelain','--untracked-files=all']))throw Error('Reference history identity or content changed');};
  await inspect();check();const shallow=await run(workspace,['rev-parse','--is-shallow-repository'])==='true';let fetchDiagnostic;
  if(shallow){try{await run(workspace,['fetch','--unshallow','--no-tags','--no-recurse-submodules','origin',saved.commit]);}catch(error){if(await run(workspace,['rev-parse','--is-shallow-repository'])!=='false')throw error;fetchDiagnostic={code:error.code??'SOURCE_GIT_UNAVAILABLE'};}}
  check();await inspect();await verify(project,sync);
  if(await run(workspace,['rev-parse','--is-shallow-repository'])!=='false')throw Error('Reference history is still shallow');
  await run(workspace,['rev-list','--objects','--missing=error','--quiet',saved.commit]);
  return {...saved,operation:'reference_history',checkedAt:new Date().toISOString(),history:{status:'complete',scope:'reference-fixed-commit-ancestors',commits:Number(await run(workspace,['rev-list','--count',saved.commit])),reused:!shallow,...(fetchDiagnostic?{fetchDiagnostic}:{})},environmentSnapshotUnchanged:true,deploymentVerified:false};
 });
}
