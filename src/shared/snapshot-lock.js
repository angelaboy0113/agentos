import {spawn} from 'node:child_process';
import path from 'node:path';
// Advisory OS lock: released by the kernel on process/pipe exit, not by age.
// Python3 is already required by the macOS credential/remote execution runtime.
const helper=`import os,sys,fcntl,stat
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
assert stat.S_ISREG(os.fstat(f).st_mode)
fcntl.flock(f,fcntl.LOCK_EX)
print('locked',flush=True)
sys.stdin.buffer.read()
`;
export async function withSnapshotLock(root,run){
 const child=spawn('python3',['-c',helper,path.join(root,'.snapshot.lock')],{stdio:['pipe','pipe','pipe']});
 child.stderr.resume();child.stdin.on('error',()=>{});
 let acquired=false;
 const exited=new Promise(resolve=>child.once('close',resolve));
 try{
  await new Promise((resolve,reject)=>{
   child.once('error',()=>reject(new Error('源码快照锁不可用；需Python3及POSIX文件锁支持')));
   let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('locked\n')){acquired=true;resolve();}});
   child.once('close',()=>{if(!acquired)reject(new Error('源码快照锁失败，未绕过并行保护'));});
  });
  if(child.exitCode!==null)throw new Error('源码快照锁已丢失');
  const check=()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error('源码快照锁已丢失，停止发布或删除');};
  return await run(check);
 }finally{child.stdin.end();await exited;}
}
