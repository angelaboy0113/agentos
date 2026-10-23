import {lstat,readdir,realpath,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pruneState} from '../shared/retention.js';
const within=(root,file)=>file.startsWith(root+path.sep);
async function entries(file){try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isDirectory())return [];return await readdir(file);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function tree(file){const info=await lstat(file);if(info.isSymbolicLink())return null;if(!info.isDirectory())return info.isFile()?{latest:info.mtimeMs,bytes:info.size}:null;let result={latest:info.mtimeMs,bytes:0};for(const n of await readdir(file)){const child=await tree(path.join(file,n));if(!child)return null;result.latest=Math.max(result.latest,child.latest);result.bytes+=child.bytes;}return result;}
function retained(state,root,alias=root){
 const refs=new Set(),names=new Set(),ids=new Set();
 const visit=v=>{if(typeof v==='string'){if(path.isAbsolute(v)){let resolved=path.resolve(v);if(within(alias,resolved))resolved=path.join(root,path.relative(alias,resolved));if(within(root,resolved))refs.add(resolved);}if(/^(?:om_|JOB-|CHAT-|QST-)/.test(v))ids.add(v);if(/^report-[a-f0-9-]{36}(?:\.csv)?$/.test(v))names.add(v.replace(/\.csv$/,''));if(/^(?:contact-images|exports|attachments)[\\/]/.test(v))refs.add(path.resolve(root,v));}else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')Object.values(v).forEach(visit);};
 visit(state.jobs);visit(state.conversations);visit(state.questions);visit(state.controlReceipts);return {refs,names,ids};
}
async function candidates(root){
 const out=[];
 const scan=async(relative,allow)=>{let parent=root;for(const part of relative.split('/')){parent=path.join(parent,part);try{if((await lstat(parent)).isSymbolicLink())return;}catch(e){if(e.code==='ENOENT')return;throw e;}}for(const n of await entries(parent))if(allow(n))out.push(path.join(parent,n));};
 await scan('exports',n=>/^JOB-[A-Za-z0-9_-]+$/.test(n));await scan('attachments',n=>/^JOB-[A-Za-z0-9_-]+$/.test(n));
 await scan('contact-images',n=>/^[a-f0-9]{32}\.png(?:\.json)?$/.test(n));
 await scan('lark-cli/reports',n=>/^report-[a-f0-9-]{36}(?:\..*)?$/.test(n));await scan('lark-cli/images',n=>/^[a-f0-9]{32}\.png$/.test(n));
 // Downloaded message resources only; never profiles, auth or pending callbacks.
 for(const profile of await entries(path.join(root,'lark-cli-events')))if(/^[A-Za-z0-9_-]+$/.test(profile))await scan('lark-cli-events/'+profile+'/messages',n=>/^om_[A-Za-z0-9_-]+$/.test(n));
 await scan('logs',n=>/\.log(?:\.[0-9-]+|\.gz)$/.test(n)); // active stdout/stderr remain owned by their logging process
 for(const n of await entries(root))if(/^agentos\.json\.\d+\.tmp$/.test(n))out.push(path.join(root,n));
 await scan('control-receipts',n=>/^[a-f0-9-]{36}\.json$/.test(n));
 return out;
}
export async function cleanupRetentionFiles(store,dataDir,cutoff,{protectIds=[]}={}){
 let root=path.resolve(dataDir);try{if((await lstat(root)).isSymbolicLink())return {deleted:0,bytes:0,unsafeRoot:true};root=await realpath(root);}catch(e){if(e.code==='ENOENT')return {deleted:0,bytes:0};throw e;}
 const files=await candidates(root),eligible=[];
 for(const file of files){try{const t=await tree(file);if(t&&t.latest<cutoff)eligible.push(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(!eligible.length)return {deleted:0,bytes:0};
 // The final reference check and removal share the state writer queue with all
 // job/lease/turn creation. No new task can acquire these paths between them.
 return store.transact(async state=>{
  const live=retained(state,root,path.resolve(dataDir));const assetNames=new Set([...live.refs].map(ref=>path.basename(ref)));for(const id of protectIds)live.ids.add(id);const receipts=new Set(Object.keys(state.controlReceipts??{}));let deleted=0,bytes=0;
  for(const file of eligible){
   const base=path.basename(file),relative=path.relative(root,file),report=base.match(/^(report-[a-f0-9-]{36})/),receipt=relative.startsWith('control-receipts'+path.sep)?base.slice(0,-5):null;
   if(live.ids.has(base)||assetNames.has(base)||report&&live.names.has(report[1])||receipt&&receipts.has(receipt)||[...live.refs].some(ref=>ref===file||within(file,ref)||within(ref,file)))continue;
   // Defend against symlinks replaced while candidates were scanned.
   let parent=file,safe=true;while(parent!==root){try{if((await lstat(parent)).isSymbolicLink()){safe=false;break;}}catch{safe=false;break;}parent=path.dirname(parent);if(!within(root,parent)&&parent!==root){safe=false;break;}}
   if(!safe)continue;
   try{const t=await tree(file);if(!t||t.latest>=cutoff)continue;await rm(file,{recursive:true,force:true});deleted++;bytes+=t.bytes;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return {deleted,bytes};
 });
}
export class RetentionService{
 constructor(context,{now=Date.now}={}){this.context=context;this.now=now;this.settings=context.config.retention;this.closed=false;}
 start({initial=true}={}){if(!this.settings?.enabled)return;if(initial)this.run().catch(()=>{});this.timer=setInterval(()=>this.run().catch(()=>{}),this.settings.intervalMs);this.timer.unref?.();}
 run(){if(this.running)return this.running;if(this.closed||!this.settings?.enabled)return Promise.resolve({disabled:true});this.running=this.sweep().catch(error=>{this.last={at:new Date(this.now()).toISOString(),ok:false,error:'RETENTION_FAILED'};console.error('[retention] cleanup incomplete; remaining data preserved');throw error;}).finally(()=>{this.running=null;});return this.running;}
 async sweep(){
  const c=this.context,now=this.now(),days=this.settings.days,cutoff=now-this.settings.maxAgeMs;
  const protectIds=[...c.controlReceipts.pending.keys(),...c.controlReceipts.pending.values()].flatMap(v=>typeof v==='string'?[v]:[v.jobId]).filter(Boolean);
  for(const key of c.cards.workers.keys())protectIds.push(key.split(':')[1]);
  for(const key of c.reports.workers.keys())protectIds.push(key.split(':')[0]);
  protectIds.push(...(c.knowledge.inflight??[]));
  const registry=path.join(c.config.dataDir,'local-executions');
  try{if((await lstat(registry)).isSymbolicLink())throw new Error('Unsafe execution registry');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of await entries(registry)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const file=path.join(registry,name),info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>4096)throw new Error('Unsafe execution registry');const entry=JSON.parse(await readFile(file,'utf8'));if(typeof entry.jobId==='string')protectIds.push(entry.jobId);}
  const state=await c.store.transact(s=>pruneState(s,{now,days,protectIds}));
  const files=await cleanupRetentionFiles(c.store,c.config.dataDir,cutoff,{protectIds});
  const live=await c.store.select(s=>({refs:new Set([...(s.jobs??[]).map(j=>'job:'+j.id),...(s.conversations??[]).map(t=>'conversation:'+t.id)]),requests:(s.conversations??[]).map(t=>t.id)}));
  for(const [key,value]of c.contacts.progressTimes??[])if(value.at<cutoff)c.contacts.progressTimes.delete(key);
  for(const [key,value]of c.store.runnerHeartbeats)if(value.at<cutoff)c.store.runnerHeartbeats.delete(key);
  const memory=await c.conversations.memory.prune(cutoff,live.refs);
  let sessions=0;if(!c.conversations.workers.size)sessions=await c.conversations.engine?.prune(cutoff,new Set(live.requests))??0;
  const knowledge=await c.knowledge.prune?.(cutoff)??0,contacts=await c.contacts.index?.prune(cutoff)??0;
  this.last={at:new Date(now).toISOString(),ok:true,days,cutoff:new Date(cutoff).toISOString(),counts:state.counts,protectedOld:state.protectedOld,files,memory,sessions,knowledge,contacts};
  await c.store.transact(s=>{s.retention.lastCleanup=this.last;});return this.last;
 }
 status(){return {enabled:this.settings?.enabled??false,days:this.settings?.days,intervalMs:this.settings?.intervalMs,last:this.last??null};}
 async close(){this.closed=true;clearInterval(this.timer);await this.running?.catch(()=>{});}
}
