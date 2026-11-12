import fs from 'node:fs/promises';import{constants}from'node:fs';import{spawn}from'node:child_process';import readline from'node:readline';
// libuv's FICLONE_FORCE is not implemented on some macOS Node builds. Use the
// actual clonefile syscall, never a silent full-copy or hard-link fallback.
export function copyOnWriteCloner(root){
 if(process.platform!=='darwin')return {clone:(s,d)=>fs.copyFile(s,d,constants.COPYFILE_FICLONE_FORCE),close:async()=>{}};
 const helper=`import os,sys,json,ctypes,stat
root=os.path.realpath(sys.argv[1]);lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True);lib.clonefile.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int]
for line in sys.stdin:
 try:
  v=json.loads(line);s,d=v['source'],v['destination']
  assert s.startswith(root+os.sep) and d.startswith(root+os.sep)
  assert os.path.realpath(s)==s and os.path.realpath(os.path.dirname(d))==os.path.dirname(d) and not os.path.lexists(d)
  q=os.lstat(s);assert stat.S_ISREG(q.st_mode) and q.st_nlink==1
  if lib.clonefile(os.fsencode(s),os.fsencode(d),0)!=0:raise OSError(ctypes.get_errno(),'clonefile')
  print(json.dumps({'ok':True}),flush=True)
 except Exception as e:print(json.dumps({'ok':False,'code':getattr(e,'errno',None)}),flush=True)
`;
 const child=spawn('/usr/bin/python3',['-u','-c',helper,root],{stdio:['pipe','pipe','pipe']}),pending=[];
 child.stderr.resume();child.stdin.on('error',()=>{});let stopped=false;
 const done=new Promise(resolve=>child.once('close',resolve));
 readline.createInterface({input:child.stdout}).on('line',l=>{const next=pending.shift();if(!next)return;try{const r=JSON.parse(l);if(!r.ok)throw Error('MAINTENANCE_CLONE_'+(r.code??'UNSAFE'));next.resolve();}catch(e){next.reject(e);}});
 const reject=e=>{stopped=true;for(const p of pending.splice(0))p.reject(e);};child.once('error',()=>reject(Error('MAINTENANCE_CLONE_HELPER')));child.once('close',()=>reject(Error('MAINTENANCE_CLONE_CLOSED')));
 return {clone:(source,destination)=>{if(stopped)return Promise.reject(Error('MAINTENANCE_CLONE_CLOSED'));return new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({source,destination})+'\n');});},close:async()=>{child.stdin.end();await done;}};
}
