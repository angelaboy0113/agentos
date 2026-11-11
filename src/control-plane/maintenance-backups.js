import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson,compactBackups,dueKey,maintenanceBusy,referenced,validateRegistry} from '../shared/maintenance-backups.js';
const VERSION=JSON.parse(await fs.readFile(new URL('../../package.json',import.meta.url))).version;
export class BackupMaintenance {
 constructor(context,{file,now=()=>new Date(),openCheck}={}){this.context=context;this.runtime=context.config.runtimeDir;this.file=file??(this.runtime?path.join(this.runtime,'maintenance-cleanup.local.json'):null);this.now=now;this.openCheck=openCheck;this.lastRun=null;}
 start(){if(!this.file)return;this.timer=setInterval(()=>this.tick().catch(()=>{}),60000);this.timer.unref();}
 async stop(){this.closed=true;clearInterval(this.timer);await this.running;}
 async inboundPending(){
  const root=path.join(this.context.config.dataDir,'lark-cli-events');let profiles;try{profiles=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  for(const p of profiles)for(const dir of ['pending-card-actions','pending-stickers']){try{if((await fs.readdir(path.join(root,p,dir))).some(n=>n.endsWith('.json')))return true;}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}}return false;
 }
 async gate(item,remove){
  if(this.closed||await this.inboundPending())return false;
  return this.context.store.inspectExclusive(state=>{
   if(this.closed||maintenanceBusy(state,{...this.context,maintenanceInert:this.config.inactiveStateRecords}))return false;
   if(item){
    if(this.referenceState!==state){this.referenceState=state;this.referenceChecks=new Map();}
    if(!this.referenceChecks.has(item.checkpoint))this.referenceChecks.set(item.checkpoint,referenced(state,item.checkpoint,this.config.referenceAliases));
    if(this.referenceChecks.get(item.checkpoint))return false;
   }
   return remove?remove():true;
  });
 }
 async tick({force=false,apply=true}={}){
  if(this.closed||this.running||!this.file)return {deferred:true};
  this.running=this.run({force,apply}).catch(e=>{this.lastRun={at:this.now().toISOString(),ok:false,deferred:Boolean(e.deferred),code:e.deferred?'MAINTENANCE_BUSY':'MAINTENANCE_FAILED'};return this.lastRun;});
  try{return await this.running;}finally{this.running=null;this.referenceState=null;this.referenceChecks=null;}
 }
 async run({force,apply}){
  let raw;try{raw=await fs.readFile(this.file);}catch(e){if(e.code==='ENOENT')return {enabled:false};throw e;}
  const c=validateRegistry(JSON.parse(raw),this.runtime);this.config=c;if(!c.enabled)return {enabled:false};
  const folder=path.join(this.runtime,'maintenance-backups');await fs.mkdir(folder,{recursive:true,mode:0o700});const statusFile=path.join(folder,'status.json');let old={};try{old=JSON.parse(await fs.readFile(statusFile));}catch(e){if(e.code!=='ENOENT')throw e;}
  const day=dueKey(c,this.now()),release=c.acceptedRelease?.version===VERSION?c.acceptedRelease?.id:null;
  if(!force&&(!day||old.day===day)&&(!release||old.release===release))return {due:false};
  if(!await this.gate())return this.lastRun={at:this.now().toISOString(),ok:true,deferred:true,code:'MAINTENANCE_BUSY'};
  const runDir=path.join(c.managedRoot,'backup-maintenance-runs',this.now().toISOString().replace(/[:.]/g,'-'));
  await fs.mkdir(runDir,{recursive:true,mode:0o700});
  const hash=createHash('sha256').update(raw).digest('hex');
  const gate=async(item,remove)=>{if(createHash('sha256').update(await fs.readFile(this.file)).digest('hex')!==hash)return false;return this.gate(item,remove);};
  const result=await compactBackups(c,{runtime:this.runtime,audit:runDir,gate,openCheck:this.openCheck,apply});
  this.lastRun={at:this.now().toISOString(),ok:true,...result};await atomicJson(path.join(runDir,'result.json'),this.lastRun);
  if(apply&&!result.deferred)await atomicJson(statusFile,{day:day??old.day,release:release??old.release,lastRun:this.lastRun});return this.lastRun;
 }
}
