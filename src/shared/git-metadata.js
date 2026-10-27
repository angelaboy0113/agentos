import {lstat,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
export function independentGitEnvironment(){
 const env={...process.env,GIT_TERMINAL_PROMPT:'0'};
 for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_INDEX_FILE'])delete env[name];
 return env;
}

// Check before any Git operation that can write. A .git file, commondir,
// alternate object store, or link can redirect writes outside the cache.
export async function verifyIndependentGit(cwd) {
 const root=path.join(cwd,'.git');
 for(const dir of [cwd,root]){
  const info=await lstat(dir);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(dir)!==dir)throw new Error('Git元数据必须属于当前独立缓存目录');
 }
 for(const relative of ['commondir','objects/info/alternates','objects/info/http-alternates','worktrees']){
  if(await lstat(path.join(root,relative)).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}))throw new Error('Git元数据包含共享对象库或worktree，未写入');
 }
 const pending=[root];
 while(pending.length){
  const dir=pending.pop();
  for(const item of await readdir(dir,{withFileTypes:true})){
   const file=path.join(dir,item.name),info=await lstat(file);
   if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile())||info.isFile()&&info.nlink>1)throw new Error('Git元数据包含符号链接、硬链接或特殊文件，未写入');
   if(info.isDirectory())pending.push(file);
  }
 }
}
