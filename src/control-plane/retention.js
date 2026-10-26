import {pruneSourceSnapshots} from '../shared/source-snapshot-gc.js';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {realDirectory} from '../shared/retention.js';
import {pruneHistory,retentionPolicy,sweepArtifacts} from '../shared/retention.js';
const DAY=86400000;
export class HistoryRetention {
 constructor(context){this.context=context;this.policy=retentionPolicy(context.config.retentionDays);this.lastRun=null;this.running=null;}
 start(){if(this.timer)return;this.run().catch(()=>{});this.timer=setInterval(()=>this.run().catch(()=>{}),this.policy.intervalMs);this.timer.unref();}
 async stop(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([this.running,this.snapshotRunning].filter(Boolean));}
 async collectSnapshots(){
  if(this.closed)return [];if(this.snapshotRunning)return this.snapshotRunning;
  this.snapshotRunning=(async()=>{const results=[];for(const [id,project]of Object.entries(this.context.projects?.projects??{}))results.push(await pruneSourceSnapshots({...project,id},{getState:()=>this.context.store.read(),apply:true}));return results;})();
  try{return await this.snapshotRunning;}finally{this.snapshotRunning=null;}
 }
 async run(now=Date.now()){
  if(!this.policy.enabled)return {disabled:true,snapshots:await this.collectSnapshots()};
  if(this.running)return this.running;
  this.running=this.collect(now).catch(error=>{this.lastRun={at:new Date(now).toISOString(),ok:false,code:'RETENTION_FAILED'};console.error('[retention] 清理失败，未清理部分保留，下次重试');throw error;});
  try{return await this.running;}finally{this.running=null;}
 }
 async collect(now){
  const c=this.context,cutoff=now-this.policy.days*DAY;
  // Serialize with message/job commits. Active records are kept, never cancelled by retention.
  const projection=await c.store.transact(state=>{
   const busyJobs=new Set([...(c.reports?.workers?.keys()??[])].map(key=>key.split(':')[0]));
   const busyCards=new Set(c.cards?.workers?.keys()??[]);
   const result=pruneHistory(state,cutoff,{busyJobs,busyCards});
   state.retention={days:this.policy.days,at:new Date(now).toISOString(),counts:result.counts};
   return {...result,expiredRefs:new Set([...result.removed].flatMap(id=>['job:'+id,'conversation:'+id])),
    sessionKeys:new Set((state.conversations??[]).map(t=>c.conversations.key(t))),
    receipts:new Set(Object.keys(state.controlReceipts??{}))};
  });
  await c.conversations.memory.prune(cutoff,projection.expiredRefs);
  for(const [id,heartbeat] of c.store.runnerHeartbeats)if(heartbeat.at<cutoff)c.store.runnerHeartbeats.delete(id);
  await c.conversations.engine?.prune(cutoff,projection.sessionKeys);
  await c.knowledge.prune?.(cutoff);
  await c.contacts.index?.prune?.(cutoff);
  let files=0;const scan=(root,options={})=>sweepArtifacts({root,cutoff,...projection,...options});
  for(const name of ['website-evidence','exports','attachments','contact-images','environment-enrollments','smoke','card-previews'])files+=await scan(path.join(c.config.dataDir,name));
  for(const name of ['reports','images','downloads'])files+=await scan(path.join(c.config.dataDir,'lark-cli',name));
  files+=await scan(path.join(c.config.dataDir,'worktrees','analysis-resources'));
  const eventRoot=path.join(c.config.dataDir,'lark-cli-events');
  if(await realDirectory(eventRoot))for(const profile of await readdir(eventRoot))files+=await scan(path.join(eventRoot,profile,'messages'));
  // pending-card-actions and lark profile/auth/config directories are deliberately outside the sweep.
  files+=await scan(path.join(c.config.dataDir,'logs'));
  // Receipt contents can carry old job results. Keep files for every remaining state receipt.
  files+=await scan(path.join(c.config.dataDir,'control-receipts'),{keptIds:projection.receipts,pattern:/^[a-f0-9-]+\.json$/});
  files+=await scan(c.config.dataDir,{pattern:/^(?:agentos.*(?:before|backup)|memory.*backup).*$/});
  const snapshots=await this.collectSnapshots();files+=snapshots.reduce((n,r)=>n+r.removed.length,0);
  if(c.config.runtimeDir){
   files+=await scan(path.join(c.config.runtimeDir,'logs'));
   // Legacy development logs/state backups only; never config, scripts, auth or deployment records.
   files+=await scan(c.config.runtimeDir,{pattern:/^(?:check.*\.log|targeted-check\.log|service\.(?:stdout|stderr)\.log|state-before-.*\.json)$/});
  }
  this.lastRun={at:new Date(now).toISOString(),ok:true,days:this.policy.days,counts:projection.counts,files};
  console.log('[retention]',JSON.stringify(this.lastRun));return this.lastRun;
 }
}
