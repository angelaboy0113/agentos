import {mkdir,writeFile,rename,readFile,readdir,lstat,unlink} from 'node:fs/promises';
import {hostname} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {interruptedInvestigation} from '../shared/investigation-budget.js';
const name=job=>createHash('sha256').update(JSON.stringify([job.id,job.lease.id])).digest('hex')+'.json';
export async function registerLocalExecution(directory,job,pid){
 if(!directory)return;
 await mkdir(directory,{recursive:true,mode:0o700});if((await lstat(directory)).isSymbolicLink())throw new Error('Execution registry must be private regular directory');
 const entry={version:1,host:hostname(),platform:process.platform,ownerPid:process.pid,workerPid:pid,jobId:job.id,runnerId:job.lease.runnerId,leaseId:job.lease.id,at:new Date().toISOString()};
 const file=path.join(directory,name(job));await writeFile(file+'.tmp',JSON.stringify(entry),{mode:0o600,flag:'wx'});await rename(file+'.tmp',file);
}
export function processAbsent(pid){
 try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}
}
// Local launcher only. Never infer a remote Runner's process identity from its display name.
export async function recoverLocalExecutions(store,directory,{host=hostname(),platform=process.platform,absent=processAbsent}={}){
 if(platform==='win32')return {recovered:0,unsupported:true}; // No equivalent negative-PID process-group proof here.
 let files;try{if((await lstat(directory)).isSymbolicLink())throw new Error('Invalid execution registry');files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return {recovered:0};throw e;}
 let recovered=0;
 for(const file of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
  let entry;const full=path.join(directory,file);
  try{const info=await lstat(full);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)continue;entry=JSON.parse(await readFile(full,'utf8'));}catch{continue;}
  if(entry.version!==1||entry.host!==host||entry.platform!==platform||![entry.ownerPid,entry.workerPid].every(p=>Number.isSafeInteger(p)&&p>1)||!absent(entry.ownerPid)||!absent(-entry.workerPid))continue;
  const candidate=await store.select(s=>s.jobs.find(j=>j.id===entry.jobId&&['running','cancelling'].includes(j.status)&&j.lease?.id===entry.leaseId&&j.lease.runnerId===entry.runnerId)?.id);
  if(!candidate){await unlink(full).catch(()=>{});continue;}
  const changed=await store.transact(state=>{
   const job=state.jobs.find(j=>j.id===entry.jobId);
   if(!job||!['running','cancelling'].includes(job.status)||job.lease?.id!==entry.leaseId||job.lease.runnerId!==entry.runnerId)return false;
   const cancelled=job.events?.some(e=>e.type==='cancel_requested');
   job.result=interruptedInvestigation(job,'本机执行器已退出，已确认原任务进程组不存在；已有成果保留，本轮没有完成交付，不自动重跑业务查询','EXECUTOR_EXITED');
   job.status=cancelled?'cancelled':'blocked';job.lease=null;delete job.environmentAccess;
   job.updatedAt=new Date().toISOString();job.events.push({type:cancelled?'cancelled':'failed',at:job.updatedAt,processesExited:true,recoveredAfterExecutorExit:true});return true;
  });
  if(changed)recovered++;
  // A terminal/stale record cannot authorize a later task or lease.
  await unlink(full).catch(()=>{});
 }
 return {recovered};
}
