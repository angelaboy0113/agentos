import {lstat,readdir,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {realDirectory} from './retention.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const git=async(cwd,args)=>(await execute('git',['-C',cwd,'-c','core.hooksPath=/dev/null',...args],{timeout:120000,maxBuffer:8*1024*1024})).stdout.trim();
import {withSnapshotLock} from './snapshot-lock.js';
const terminal=new Set(['completed','failed','cancelled','blocked']);
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
const visit=(x,fn)=>{if(typeof x==='string')fn(x);else if(x&&typeof x==='object')for(const v of Object.values(x))visit(v,fn);};
const program=fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,'');
export async function pruneSourceSnapshots(project,{getState,apply=false}={}){
 if(project.analysisSourceMode!=='isolated'||!project.analysisSnapshotRoot)return {removed:[],kept:[],skipped:'not-configured'};
 const root=path.resolve(project.analysisSnapshotRoot);
 let source;try{source=await realpath(project.repoPath);}catch{return {removed:[],kept:[],skipped:'source-missing'};}
 if(!await realDirectory(root)||inside(root,source)||inside(source,root)||inside(root,program)||inside(program,root))return {removed:[],kept:[],skipped:'unsafe-root'};
 return withSnapshotLock(root,async()=>{
  // Read state AFTER locking. New source users acquire the same lock, so a job
  // created after this read cannot begin reading a directory being reclaimed.
  const state=await getState();
  const projectJobs=(state.jobs??[]).filter(j=>j.projectId===project.id||!project.id);
  if(projectJobs.some(j=>['queued','running','cancelling'].includes(j.status)))return {removed:[],kept:[],skipped:'project-busy'};
  const activeQuestions=new Set(projectJobs.filter(j=>!terminal.has(j.status)).map(j=>j.questionId));
  for(const t of state.conversations??[])if(['queued','thinking','decided','ready'].includes(t.status)||(t.setupPending&&t.status!=='sent'))activeQuestions.add(t.questionId);
  for(const d of [...Object.values(state.reportDeliveries??{}),...Object.values(state.websiteEvidenceDeliveries??{})])if(!d.messageId&&!d.superseded)activeQuestions.add(d.questionId);
  const pins=new Set();
  for(const j of state.jobs??[])if(!terminal.has(j.status)||activeQuestions.has(j.questionId))visit(j,v=>{if(path.isAbsolute(v)&&inside(root,path.resolve(v)))pins.add(path.resolve(v));});
  const candidates=[],kept=[],removed=[],unknown=[];
  for(const name of await readdir(root)){
   if(!/^(?:analysis|building)-[A-Za-z0-9]+$/.test(name))continue;
   const folder=path.join(root,name),s=await lstat(folder);
   if(!s.isDirectory()||s.isSymbolicLink()||!await realDirectory(folder)){unknown.push(name);continue;}
   if(name.startsWith('building-')){
    try{const owner=JSON.parse(await readFile(path.join(folder,'build-owner.json'),'utf8'));if(owner.policy!=='snapshot-build-v1'||owner.sourceRoot!==source)throw new Error();if([...pins].some(p=>inside(folder,p)||inside(p,folder)))throw new Error();if(apply)await rm(folder,{recursive:true});removed.push({name,environment:owner.environment,reason:'abandoned-build'});}catch{unknown.push(name);}continue;
   }
   let manifest;
   try{manifest=JSON.parse(await readFile(path.join(folder,'source-manifest.json'),'utf8'));}catch{unknown.push(name);continue;}
   if(manifest.policy!=='isolated-environment-source-v1'||manifest.sourceRoot!==source||manifest.workspace!==path.join(folder,'workspace')||!Array.isArray(manifest.repositories)||!manifest.repositories.length||!Number.isFinite(Date.parse(manifest.checkedAt))){unknown.push(name);continue;}
   if(!await realDirectory(manifest.workspace)){unknown.push(name);continue;}
   candidates.push({folder,name,manifest});
  }
  const latest=new Map();
  for(const item of candidates)if(!latest.has(item.manifest.environment)||Date.parse(item.manifest.checkedAt)>Date.parse(latest.get(item.manifest.environment).manifest.checkedAt))latest.set(item.manifest.environment,item);
  // A newly observed rollback may use an older existing snapshot: the latest
  // pointer records remote selection, not merely snapshot creation time.
  for(const name of await readdir(root))if(/^latest-[a-f0-9]{32}\.json$/.test(name)){
   try{const pointer=JSON.parse(await readFile(path.join(root,name),'utf8'));const item=candidates.find(c=>c.name===pointer.container&&c.manifest.environment===pointer.environment);if(item)latest.set(pointer.environment,item);}catch{}
  }
  for(const item of candidates){
   const pinned=[...pins].some(p=>inside(item.folder,p)||inside(p,item.folder));
   if(pinned||latest.get(item.manifest.environment)===item){kept.push({name:item.name,environment:item.manifest.environment,reason:pinned?'active-reference':'latest-environment'});continue;}
   // Refuse unexpected symlinks anywhere, including nested Git metadata. Only
   // independently owned clone directories are managed; never Git worktrees.
   let safe=true;const scan=async d=>{for(const name of await readdir(d)){const f=path.join(d,name),s=await lstat(f);if(s.isSymbolicLink()){
      // A tracked source symlink is removed as a link by rm, never followed.
      // Unexpected links and all links in Git metadata remain protected.
      const rel=path.relative(item.manifest.workspace,f);const repos=item.manifest.repositories.filter(r=>inside(path.resolve(item.manifest.workspace,r.path),f)).sort((a,b)=>b.path.length-a.path.length);
      try{const repo=repos[0],cwd=path.resolve(item.manifest.workspace,repo.path),file=path.relative(cwd,f);if(rel.split(path.sep).includes('.git')||!(await git(cwd,['ls-files','--stage','--',file])).startsWith('120000 '))throw new Error();}catch{safe=false;return;}continue;
     }if(name==='.git'&&!s.isDirectory()){safe=false;return;}if(s.isDirectory())await scan(f);if(!safe)return;}};
   await scan(item.folder);if(!safe){unknown.push(item.name);continue;}
   try{
    for(const repo of item.manifest.repositories){
     const cwd=path.resolve(item.manifest.workspace,repo.path);if(!inside(item.manifest.workspace,cwd)||await realpath(cwd)!==cwd||await git(cwd,['rev-parse','--show-toplevel'])!==cwd||await git(cwd,['rev-parse','HEAD'])!==repo.commit)throw new Error();
     const children=item.manifest.repositories.filter(r=>r.path!==repo.path&&inside(cwd,path.resolve(item.manifest.workspace,r.path))).map(r=>':(exclude)'+path.relative(cwd,path.resolve(item.manifest.workspace,r.path)));
     if(await git(cwd,['status','--porcelain','--untracked-files=all','--','.',...children]))throw new Error();
    }
   }catch{unknown.push(item.name);continue;}
   if(apply)await rm(item.folder,{recursive:true,force:false});
   removed.push({name:item.name,environment:item.manifest.environment});
  }
  return {apply,removed,kept,unknown};
 });
}
