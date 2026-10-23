import {mkdirSync,lstatSync,openSync,writeSync,closeSync,constants} from 'node:fs';
import path from 'node:path';
// An instance-owned log directory only. No logger modifies another deployment's streams/files.
export function installDailyLogs(directory){
 const root=path.resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
 let current=path.parse(root).root;
 for(const part of root.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Log directory contains symlink');}
 const restore=[];
 for(const [kind,stream] of [['stdout',process.stdout],['stderr',process.stderr]]){
  const original=stream.write;
  stream.write=function(chunk,encoding,callback){
   if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
   try{
    const file=path.join(root,new Date().toISOString().slice(0,10)+'.'+kind+'.log');
    const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|(constants.O_NOFOLLOW??0),0o600);
    try{const data=Buffer.isBuffer(chunk)||chunk instanceof Uint8Array?chunk:Buffer.from(chunk,encoding);let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset);}finally{closeSync(fd);}
    if(callback)queueMicrotask(()=>callback());return true;
   }catch(error){return original.call(stream,'[daily-log] write failed\n',callback);}
  };
  restore.push(()=>{stream.write=original;});
 }
 return ()=>restore.forEach(fn=>fn());
}
