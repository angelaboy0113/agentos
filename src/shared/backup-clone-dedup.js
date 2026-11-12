import fs from'node:fs/promises';import{renameSync,lstatSync,realpathSync}from'node:fs';import path from'node:path';import{createHash,randomUUID}from'node:crypto';
import{safePath,files,fileDigest,signature,atomicJson}from'./maintenance-backups.js';import{copyOnWriteCloner}from'./clone-file.js';
const key=(kind,rel,size)=>JSON.stringify([kind,rel,size]),hash=x=>createHash('sha256').update(x).digest('hex');
export async function deduplicateBackupClones(c,{runtime,audit,gate,openCheck,apply,data,protectedPaths}){
 const result={version:2,policy:'copy-on-write-backup-dedup-v1',apply,coalescedFiles:0,logicalDuplicateBytes:0,removed:0,allBackupPathsPreserved:true,legacyAnchorBytesAndPathsPreserved:true,protectedCheckpoints:[...protectedPaths],deferred:false};
 const newest=[...c.checkpoints].sort((a,b)=>Date.parse(b.acceptedAt)-Date.parse(a.acceptedAt)).slice(0,3),newestSet=new Set(newest.map(x=>x.path)),catalog=new Map(),hashes=new Map(),receiptFile=path.join(runtime,'maintenance-backups/clone-receipts.json');
 let receipts={};try{await safePath(receiptFile,runtime);receipts=JSON.parse(await fs.readFile(receiptFile));if(!receipts||Array.isArray(receipts)||typeof receipts!=='object')throw Error('MAINTENANCE_CLONE_RECEIPTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const before=await fs.statfs(runtime),cloner=apply?copyOnWriteCloner(c.managedRoot):null;
 const check=async()=>{if(await gate())return true;result.deferred=true;return false;};
 const digest=async file=>{const s=signature(await fs.lstat(file)),cached=hashes.get(file);if(cached?.signature===s)return cached;const d=await fileDigest(file);hashes.set(file,d);return d;};
 try{
  if(!await check())return result;
  for(const b of newest)for(const kind of ['exports','control-receipts']){
   const base=path.join(data.get(b.path),kind);try{await safePath(base,c.managedRoot);}catch(e){if(e.code==='ENOENT')continue;throw e;}
   for await(const f of files(base)){const s=await fs.lstat(f);if(s.nlink!==1)continue;const k=key(kind,path.relative(base,f),s.size);if(!catalog.has(k))catalog.set(k,f);}
  }
  const journal=apply?await fs.open(path.join(audit,'clone-replacements.jsonl'),'a',0o600):null;let changed=0;
  if(apply){const parent=await fs.open(audit,'r');try{await parent.sync();}finally{await parent.close();}}
  try{for(const x of c.candidates){
   if(newestSet.has(x.checkpoint))continue;if(!await check())break;
   if(!await openCheck(x.checkpoint)){result.deferred=true;continue;}
   for await(const file of files(x.path)){
    if(!await check())break;await safePath(file,c.managedRoot);const stat=await fs.lstat(file);if(stat.nlink!==1)continue;
    const source=catalog.get(key(x.kind,path.relative(x.path,file),stat.size));if(!source||source===file)continue;await safePath(source,c.managedRoot);
    const retained=await digest(source),id=hash(file);if(receipts[id]?.signature===signature(stat)&&receipts[id]?.sha256===retained.sha256)continue;
    const original=await fileDigest(file);if(original.sha256!==retained.sha256)continue;result.logicalDuplicateBytes+=original.bytes;if(!apply)continue;
    const temp=path.join(path.dirname(file),'.agentos-clone-'+randomUUID());
    try{
     await cloner.clone(source,temp);if((await fileDigest(temp)).sha256!==original.sha256)throw Error('MAINTENANCE_CLONE_HASH');await fs.chmod(temp,original.mode);await fs.utimes(temp,original.mtimeMs/1000,original.mtimeMs/1000);
     const fd=await fs.open(temp,'r');try{await fd.sync();}finally{await fd.close();}
     const cloneSignature=signature(await fs.lstat(temp));await journal.write(JSON.stringify({at:new Date().toISOString(),file,source,sha256:original.sha256,bytes:original.bytes,beforeSignature:original.signature,preservesPathAndBytes:true})+'\n');await journal.sync();
     const replaced=await gate({checkpoint:x.checkpoint},()=>{
      for(const p of [source,file,temp]){if(realpathSync(p)!==p)throw Error('MAINTENANCE_CLONE_PATH');for(let q=p;q!==c.managedRoot;q=path.dirname(q))if(lstatSync(q).isSymbolicLink())throw Error('MAINTENANCE_SYMLINK');}
      if(signature(lstatSync(source))!==retained.signature||signature(lstatSync(file))!==original.signature||signature(lstatSync(temp))!==cloneSignature)return false;
      renameSync(temp,file);return true;
     });
     if(!replaced){result.deferred=true;break;}
     const parent=await fs.open(path.dirname(file),'r');try{await parent.sync();}finally{await parent.close();}
     receipts[id]={signature:signature(await fs.lstat(file)),sha256:original.sha256};result.coalescedFiles++;changed++;
     if(changed%128===0){await atomicJson(receiptFile,receipts);await atomicJson(path.join(audit,'clone-progress.json'),{at:new Date().toISOString(),...result});}
    }finally{await fs.rm(temp,{force:true});}
   }
   if(result.deferred)break;
  }}finally{await journal?.close();if(apply&&changed)await atomicJson(receiptFile,receipts);}
 }finally{await cloner?.close();}
 const after=await fs.statfs(runtime);result.observedFreeBytesChange=Number(after.bavail)*Number(after.bsize)-Number(before.bavail)*Number(before.bsize);result.logicalIsNotPhysical=true;
 await atomicJson(path.join(audit,'clone-result.json'),result);return result;
}
