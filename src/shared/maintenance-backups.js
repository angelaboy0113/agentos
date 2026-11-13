import{withdrawnCardInert}from'./withdrawn-delivery.js';
// Only owner-registered historical bulk directories; never a general runtime sweep.
import fs from 'node:fs/promises';
import {createReadStream,unlinkSync,lstatSync,realpathSync,renameSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const within=(p,r)=>p===r||p.startsWith(r+path.sep);
export async function safePath(p,root){
 if(!path.isAbsolute(p)||path.normalize(p)!==p||!within(p,root)||p===root)throw Error('MAINTENANCE_PATH');
 for(let q=p;;q=path.dirname(q)){const s=await fs.lstat(q);if(s.isSymbolicLink())throw Error('MAINTENANCE_SYMLINK');if(q===root)break;}
 if(await fs.realpath(root)!==root)throw Error('MAINTENANCE_ROOT');return p;
}
export const signature=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
export async function fileDigest(p){const a=await fs.lstat(p);if(!a.isFile()||a.isSymbolicLink())throw Error('MAINTENANCE_FILE');const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);if(signature(a)!==signature(await fs.lstat(p)))throw Error('MAINTENANCE_CHANGED');return {sha256:h.digest('hex'),signature:signature(a),bytes:a.size,mode:a.mode&0o777,mtimeMs:a.mtimeMs};}
export async function atomicJson(p,value){await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp',f=await fs.open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2));await f.sync();}finally{await f.close();}await fs.rename(tmp,p);const parent=await fs.open(path.dirname(p),'r');try{await parent.sync();}finally{await parent.close();}}
export async function* files(root){for(const e of await fs.readdir(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){if(['.git','node_modules','website-sessions','worktrees'].includes(e.name))continue;yield*files(p);}else if(e.isFile())yield p;}}
export async function noOpenFiles(root){
 try{await exec('/usr/sbin/lsof',['-nP','+D',root],{maxBuffer:1024*1024});return false;}catch(e){if(e.code===1&&!e.stderr)return !e.stdout;throw Error('MAINTENANCE_OPEN_CHECK');}
}
export function dueKey(config,now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 if(Number(parts.hour)*60+Number(parts.minute)<config.hour*60+config.minute)return null;return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validateRegistry(c,runtime){
 if(c.version!==1||typeof c.enabled!=='boolean'||!Number.isInteger(c.hour)||c.hour<0||c.hour>23||!Number.isInteger(c.minute)||c.minute<0||c.minute>59)throw Error('MAINTENANCE_CONFIG');
 if(c.contentStore&&(typeof c.contentStore.enabled!=='boolean'||![undefined,'gzip','clone'].includes(c.contentStore.mode)))throw Error('MAINTENANCE_CONFIG');
 new Intl.DateTimeFormat('en',{timeZone:c.timeZone}).format();
 if(c.managedRoot!==path.join(runtime,'migration')||!Array.isArray(c.checkpoints)||!Array.isArray(c.pins)||!Array.isArray(c.candidates))throw Error('MAINTENANCE_REGISTRY');
 for(const b of c.checkpoints)if(!b.path||!Number.isFinite(Date.parse(b.acceptedAt))||!b.proof?.path||!/^[a-f0-9]{64}$/.test(b.proof.sha256))throw Error('MAINTENANCE_PROOF');
 if(new Set(c.checkpoints.map(b=>b.path)).size!==c.checkpoints.length)throw Error('MAINTENANCE_DUPLICATE');
 return c;
}
export async function checkpointData(p,root){await safePath(p,root);for(const n of ['runtime-data','stopped-runtime-data','data']){const d=path.join(p,n);try{await safePath(path.join(d,'agentos.json'),root);return d;}catch(e){if(e.code!=='ENOENT')throw e;}}throw Error('MAINTENANCE_CHECKPOINT');}
export async function checkedRegistry(c,runtime){
 validateRegistry(c,runtime);const root=c.managedRoot;const sorted=[...c.checkpoints].sort((a,b)=>Date.parse(b.acceptedAt)-Date.parse(a.acceptedAt));
 if(sorted.length<3)throw Error('MAINTENANCE_THREE_CHECKPOINTS');
 const protectedPaths=new Set([...c.pins,...sorted.slice(0,3).map(b=>b.path)]),data=new Map();
 // Every anchor is a pin. No automatic anchor rotation or unique-file deletion.
 for(const b of c.checkpoints){await safePath(b.proof.path,root);if(sha(await fs.readFile(b.proof.path))!==b.proof.sha256)throw Error('MAINTENANCE_PROOF_CHANGED');data.set(b.path,await checkpointData(b.path,root));}
 for(const p of protectedPaths){if(!data.has(p))throw Error('MAINTENANCE_UNREGISTERED_PIN');}
 for(const x of c.candidates){const d=data.get(x.checkpoint);if(!d||!['exports','control-receipts'].includes(x.kind)||x.path!==path.join(d,x.kind))throw Error('MAINTENANCE_CANDIDATE');await safePath(x.path,root);}
 return {protectedPaths,data};
}
export function referenced(state,checkpoint,aliases=[]){const text=JSON.stringify(state);return [checkpoint,...aliases.map(a=>checkpoint.replace(a.current,a.previous))].some(p=>text.includes(p));}
export function inactiveRecordFingerprint(group,value){
 // Transport retries can change these four fields without changing the message,
 // destination, original identity or pending delivery. Never omit payload/scope.
 const stable=group==='cardMessages'?Object.fromEntries(Object.entries(value).filter(([k])=>!['revision','updatedAt','failures','retryAt'].includes(k))):value;
 return sha(JSON.stringify(stable));
}
export function maintenanceBusy(state,context={}){
 const inert=(group,key,value)=>{const expected=context.maintenanceInert?.[group]?.[key];return typeof expected==='string'&&expected===inactiveRecordFingerprint(group,value);};
 if((state.jobs??[]).some(j=>['queued','running','cancelling'].includes(j.status))||(state.conversations??[]).some(c=>['queued','thinking','decided','ready'].includes(c.status)))return true;
 if(context.reception?.running||context.controlReceipts?.pending?.size||(typeof context.adminUsageExports==='number'?context.adminUsageExports:context.adminUsageExports?.size))return true;
 if(['reports','websiteEvidence','successStickers'].some(k=>context[k]?.workers?.size))return true;
 if(context.cards?.workers?.size&&[...context.cards.workers.keys()].some(k=>!state.cardMessages?.[k]||!inert('cardMessages',k,state.cardMessages[k])))return true;
 if(Object.entries(state.receptionInbox??{}).some(([key,e])=>!inert('receptionInbox',key,e)&&['queued','reminding','diagnosing'].includes(e.status))||Object.entries(state.recoveryEvents??{}).some(([key,e])=>!inert('recoveryEvents',key,e)&&['queued','diagnosing'].includes(e.status)))return true;
 if(Object.entries(state.cardMessages??{}).some(([key,c])=>!withdrawnCardInert(state,key,c)&&!inert('cardMessages',key,c)&&(c.revision!==c.deliveredRevision||c.terminalMention&&!c.mentionDelivered)))return true;
 for(const k of ['reportDeliveries','websiteEvidenceDeliveries','stickerDeliveries'])if(Object.values(state[k]??{}).some(d=>!d.superseded&&!d.deliveredAt&&(!d.messageId||d.parts?.some(p=>!p.messageId))))return true;
 return false;
}
// lock is deliberately never auto-stolen after a crash. Operator may inspect/remove it.
export async function acquire(root){const p=path.join(root,'.backup-maintenance.lock');try{await fs.mkdir(p,{mode:0o700});await atomicJson(path.join(p,'owner.json'),{pid:process.pid,at:new Date().toISOString()});return async()=>fs.rm(p,{recursive:true});}catch(e){if(e.code==='EEXIST')return null;throw e;}}
async function compact(c,{runtime,audit,gate,openCheck=noOpenFiles,apply=false}){
 const pinsFile=path.join(runtime,'maintenance-backups','anchor-pins.json');let pins=[];
 try{pins=JSON.parse(await fs.readFile(pinsFile));if(!Array.isArray(pins))throw Error('MAINTENANCE_PINS');}catch(e){if(e.code!=='ENOENT')throw e;}
 c={...c,pins:[...new Set([...c.pins,...pins])]};
 const {protectedPaths,data}=await checkedRegistry(c,runtime);
await safePath(audit,c.managedRoot);
 let contentResult;
 if(c.contentStore?.enabled===true&&c.contentStore.mode==='clone'){
  const {deduplicateBackupClones}=await import('./backup-clone-dedup.js');
  contentResult=await deduplicateBackupClones(c,{runtime,audit,gate,openCheck,apply,protectedPaths,data});
  if(contentResult.deferred)return contentResult;
  c={...c,candidates:[]};
 }else if(c.contentStore?.enabled===true){
  const {archiveHistoricalBulk}=await import('./backup-content-store.js');
  contentResult=await archiveHistoricalBulk(c,{runtime,audit,gate,openCheck,apply,protectedPaths,data});
  if(contentResult.deferred)return contentResult;
  c={...c,candidates:[]}; // Content archival replaces only the legacy bulk pass.
 }
 const result={version:1,apply,removed:0,duplicateFiles:0,logicalBytes:0,uniquePreserved:0,protectedCheckpoints:[...protectedPaths],deferred:false};
 const anchors=[];
 for(const p of protectedPaths)for(const kind of ['exports','control-receipts']){const base=path.join(data.get(p),kind);try{await safePath(base,c.managedRoot);anchors.push({base,kind,checkpoint:p});}catch(e){if(e.code!=='ENOENT')throw e;}}
 const index=new Map();let steps=0;
 const check=async()=>{if(!await gate())throw Object.assign(Error('MAINTENANCE_BUSY'),{deferred:true,partial:{...result}});};
 const pulse=async()=>{if(++steps%100===0)await check();};await check();
 const eligible=c.candidates.filter(x=>!protectedPaths.has(x.checkpoint));
 for(const a of eligible.length?anchors:[])for await(const f of files(a.base)){await pulse();const s=await fs.lstat(f);const key=[a.kind,path.relative(a.base,f),s.size].join('\0');if(!index.has(key))index.set(key,[]);index.get(key).push({file:f,checkpoint:a.checkpoint});}
 const before=await fs.statfs(runtime);const anchorHashes=new Map();
 for(const x of c.candidates){
  if(protectedPaths.has(x.checkpoint))continue;await check();
  if(!await openCheck(x.checkpoint)){result.deferred=true;continue;}
  // A durable gzip plan is written and fsynced before each bulk root is modified.
  const plan=[];
  for await(const f of files(x.path)){
   await pulse();const stat=await fs.lstat(f),key=[x.kind,path.relative(x.path,f),stat.size].join('\0');let match;
   for(const a of index.get(key)??[]){
    await check();await safePath(f,c.managedRoot);await safePath(a.file,c.managedRoot);
    const original=await fileDigest(f);let anchor=anchorHashes.get(a.file);if(!anchor){anchor=await fileDigest(a.file);anchorHashes.set(a.file,anchor);}
    if(original.sha256===anchor.sha256){match={file:f,checkpoint:x.checkpoint,root:x.path,...original,retained:a.file,retainedCheckpoint:a.checkpoint,retainedSignature:anchor.signature};break;}
   }
   if(match)plan.push(match);else result.uniquePreserved++;
  }
  if(!plan.length)continue;await check();if(!await openCheck(x.checkpoint)){result.deferred=true;continue;}result.duplicateFiles+=plan.length;
  if(!apply)continue;
  const ledger=path.join(audit,randomUUID()+'.plan.json.gz');const payload=Buffer.from(JSON.stringify({version:1,managedRoot:c.managedRoot,plan}));const zipped=gzipSync(payload);
  if(!gunzipSync(zipped).equals(payload))throw Error('MAINTENANCE_LEDGER');const fd=await fs.open(ledger,'wx',0o600);try{await fd.writeFile(zipped);await fd.sync();}finally{await fd.close();}
  pins=[...new Set([...pins,...plan.map(i=>i.retainedCheckpoint)])];await atomicJson(pinsFile,pins);
  const parent=await fs.open(audit,'r');try{await parent.sync();}finally{await parent.close();}
  for(const item of plan){
   // Hashing outside the writer fence. Signatures and new task references are checked
   // again inside it; no state write or entire-state clone is required.
   await check();await safePath(item.file,c.managedRoot);await safePath(item.retained,c.managedRoot);
   if((await fileDigest(item.retained)).sha256!==item.sha256)throw Error('MAINTENANCE_ANCHOR_CHANGED');
   const removed=await gate(item,()=>{
    for(const p of [item.file,item.retained]){if(realpathSync(p)!==p)throw Error('MAINTENANCE_SYMLINK');for(let q=p;q!==c.managedRoot;q=path.dirname(q))if(lstatSync(q).isSymbolicLink())throw Error('MAINTENANCE_SYMLINK');}
    if(signature(lstatSync(item.file))!==item.signature||signature(lstatSync(item.retained))!==item.retainedSignature)return false;
    unlinkSync(item.file);return true;
   });
   if(!removed){result.deferred=true;break;}result.removed++;result.logicalBytes+=item.bytes;
  }
  await atomicJson(ledger+'.result.json',{removed:result.removed,restorePlan:ledger});if(result.deferred)break;
 }
 result.testTreesRemoved=0;
 for(const tree of c.testTrees??[]){
  await check();try{await safePath(tree.path,c.managedRoot);}catch(e){if(e.code==='ENOENT')continue;throw e;}await safePath(tree.proof.path,c.managedRoot);
  if(path.basename(tree.path)!=='node_modules'||[...data.keys()].some(p=>within(tree.path,p)||within(p,tree.path)))throw Error('MAINTENANCE_TEST_TREE');
  const proof=await fs.readFile(tree.proof.path);if(sha(proof)!==tree.proof.sha256||!/# pass [1-9]\d*\b/.test(proof.toString())||!/# fail 0\b/.test(proof.toString()))throw Error('MAINTENANCE_TEST_PROOF');
  if(await dependencyDigest(tree.path)!==tree.sha256)throw Error('MAINTENANCE_TEST_CHANGED');
  if(!await openCheck(path.dirname(tree.path))){result.deferred=true;continue;}
  if(!apply)continue;
  const retired=path.join(audit,'retired-dependencies-'+randomUUID());
  await atomicJson(retired+'.json',{original:tree.path,sha256:tree.sha256,proof:tree.proof,rebuild:'npm ci in the original isolated test checkout'});
  const moved=await gate({checkpoint:path.dirname(tree.path)},()=>{if(realpathSync(tree.path)!==tree.path)throw Error('MAINTENANCE_SYMLINK');renameSync(tree.path,retired);return true;});
  if(!moved){result.deferred=true;break;}
  // Rename detaches only verified closed test dependencies. Recursive rm never follows links.
  if(await dependencyDigest(retired)!==tree.sha256)throw Error('MAINTENANCE_TEST_QUARANTINED');
  await fs.rm(retired,{recursive:true});result.testTreesRemoved++;
 }
 const after=await fs.statfs(runtime);result.observedFreeBytesChange=Number(after.bavail)*Number(after.bsize)-Number(before.bavail)*Number(before.bsize);result.logicalIsNotPhysical=true;
 return contentResult?{...contentResult,testTreesRemoved:result.testTreesRemoved,deferred:result.deferred,observedFreeBytesChange:contentResult.observedFreeBytesChange+result.observedFreeBytesChange}:result;
}
export async function dependencyDigest(root){
 const h=createHash('sha256');
 async function walk(dir){for(const e of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='.git')throw Error('MAINTENANCE_TEST_GIT');const f=path.join(dir,e.name),rel=path.relative(root,f);if(e.isSymbolicLink())h.update(JSON.stringify([rel,'link',await fs.readlink(f)]));else if(e.isDirectory())await walk(f);else if(e.isFile())h.update(JSON.stringify([rel,(await fileDigest(f)).sha256]));else throw Error('MAINTENANCE_TEST_FILE');}}
 await walk(root);return h.digest('hex');
}
export async function compactBackups(c,options){
 await safePath(options.audit,c.managedRoot);const release=await acquire(c.managedRoot);
 if(!release)return {deferred:true,code:'MAINTENANCE_LOCKED'};
 try{return await compact(c,options);}finally{await release();}
}
export async function restorePlan(ledger,{destination,managedRoot}){
 await safePath(ledger,managedRoot);await safePath(destination,managedRoot);const {plan,version}=JSON.parse(gunzipSync(await fs.readFile(ledger)));if(version!==1)throw Error('MAINTENANCE_LEDGER');let restored=0;
 // Destination must be a NEW empty directory outside all original backup roots.
 if((await fs.readdir(destination)).length||plan.some(i=>within(destination,i.checkpoint)||within(i.file,destination)||within(destination,i.retainedCheckpoint)))throw Error('MAINTENANCE_RESTORE_DESTINATION');
 for(const i of plan){await safePath(i.retained,managedRoot);if((await fileDigest(i.retained)).sha256!==i.sha256)throw Error('MAINTENANCE_ANCHOR_CHANGED');const rel=path.relative(i.root,i.file);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('MAINTENANCE_LEDGER');const p=path.join(destination,rel);await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});await fs.copyFile(i.retained,p,1);await fs.chmod(p,i.mode);await fs.utimes(p,new Date(i.mtimeMs),new Date(i.mtimeMs));if((await fileDigest(p)).sha256!==i.sha256)throw Error('MAINTENANCE_RESTORE_HASH');restored++;}
 return {restored,hashesVerified:true};
}
