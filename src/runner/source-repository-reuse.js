import {lstat,readdir,mkdir,realpath,readlink,symlink,copyFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {copyOnWriteCloner} from '../shared/clone-file.js';
import {verifyIndependentGit} from '../shared/git-metadata.js';
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);

// New bundle, unchanged repository: independent inodes/index/objects, shared disk
// extents where supported. No alternates, hard links or mutable worktree sharing.
export async function reuseSnapshotRepository({root,seed,target,commit,origin,children=[]},git,{cloner}={}){
 if(!inside(root,seed)||!inside(root,target)||seed===target||await realpath(root)!==root||await realpath(seed)!==seed)throw Error('Repository reuse outside managed cache');
 const ignored=children.map(c=>path.resolve(seed,c));
 if(ignored.some(c=>c===seed||!inside(seed,c)))throw Error('Invalid nested repository exclusion');
 const exclusions=ignored.map(c=>':(exclude)'+path.relative(seed,c)),scope=['--','.',...exclusions];
 const check=async cwd=>{
  await verifyIndependentGit(cwd);
  if(await git(cwd,['rev-parse','HEAD'])!==commit||await git(cwd,['remote','get-url','origin'])!==origin)throw Error('Repository reuse identity changed');
  if(await git(cwd,['status','--porcelain','--untracked-files=all',...scope]))throw Error('Repository reuse contains changes');
  const extra=(await git(cwd,['ls-files','--others','--ignored','--exclude-standard',...scope])).split('\n').filter(Boolean);
  if(extra.some(p=>!ignored.some(child=>inside(child,path.resolve(seed,p.replace(/\/$/,''))))))throw Error('Repository reuse contains ignored data');
 };
 await check(seed);const dest=await lstat(target);if(!dest.isDirectory()||dest.isSymbolicLink()||await realpath(target)!==target||(await readdir(target)).length)throw Error('Repository reuse destination not empty');
 const copier=cloner??copyOnWriteCloner(root),stats={policy:'independent-repository-cow-v1',files:0,bytes:0,cowFiles:0,copiedFiles:0};
 const copy=async(from,to,inGit=false)=>{
  for(const item of await readdir(from,{withFileTypes:true})){
   const s=path.join(from,item.name),d=path.join(to,item.name);if(ignored.some(c=>s===c))continue;
   const st=await lstat(s),metadata=inGit||item.name==='.git';
   if(st.isDirectory()&&!st.isSymbolicLink()){await mkdir(d,{mode:st.mode&0o777});await copy(s,d,metadata);}
   else if(st.isSymbolicLink()&&!metadata){
    const tracked=await git(seed,['ls-files','--stage','--',path.relative(seed,s)]);if(!tracked.startsWith('120000 '))throw Error('Untracked link in repository seed');await symlink(await readlink(s),d);
   }else if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1){
    try{await copier.clone(s,d);stats.cowFiles++;}catch(error){if(!/MAINTENANCE_CLONE_(?:18|45|95|UNSUPPORTED)|ENOTSUP|EXDEV|ENOSYS/.test(error.message+' '+error.code))throw error;await copyFile(s,d,constants.COPYFILE_EXCL);stats.copiedFiles++;}
    const after=await lstat(s),written=await lstat(d);if(after.ino!==st.ino||after.size!==st.size||after.mtimeMs!==st.mtimeMs||written.ino===st.ino||written.nlink!==1)throw Error('Repository seed changed while copying');stats.files++;stats.bytes+=st.size;
   }else throw Error('Unsafe repository seed file');
  }
 };
 try{await copy(seed,target);await check(seed);await check(target);return stats;}
 catch(error){for(const name of await readdir(target))await rm(path.join(target,name),{recursive:true,force:true});throw error;}
 finally{if(!cloner)await copier.close();}
}
