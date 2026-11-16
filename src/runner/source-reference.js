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
 if(job?.taskIntent!=='analysis'||sync?.policy!=='isolated-environment-source-v1'||!['list_branches','read_branch'].includes(query.operation)||typeof query.reason!=='string'||!query.reason.trim())throw Error('Invalid source reference request');
 const repo=sync.repositories.find(r=>r.path===query.repository);if(!repo)throw Error('Source reference repository is outside the original scope');
 await verify(project,sync);
 const source=path.resolve(sync.workspace,repo.path);await verifyIndependentGit(source);
 const origin=await run(source,['remote','get-url','origin']);
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
