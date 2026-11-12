// Historical bulk only. Objects are compressed, independently verified copies;
// no links to live files, no executable archive entries, no checkpoint removal.
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream,lstatSync,unlinkSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {safePath,fileDigest,signature,atomicJson,files} from './maintenance-backups.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Error('MAINTENANCE_CONTENT_'+code);};
const relative=p=>typeof p==='string'&&p.length>0&&!path.isAbsolute(p)&&p.split(/[\\/]/).every(s=>s&&s!=='.'&&s!=='..');
async function directory(p,root){await fs.mkdir(p,{recursive:true,mode:0o700});await safePath(p,root);if(!(await fs.lstat(p)).isDirectory())fail('DIRECTORY');}
function objectPath(base,sha){if(!/^[a-f0-9]{64}$/.test(sha??''))fail('HASH');return path.join(base,'objects',sha.slice(0,2),sha+'.gz');}
async function decoded(object,entry,destination){
 const h=createHash('sha256');let bytes=0;
 const verify=new Transform({transform(b,_,done){bytes+=b.length;if(bytes>entry.bytes)return done(Error('MAINTENANCE_CONTENT_SIZE'));h.update(b);done(null,b);}});
 const sink=destination?createWriteStream(destination,{flags:'wx',mode:0o600}):new Transform({transform(_b,_e,cb){cb();}});
 await pipeline(createReadStream(object),createGunzip(),verify,sink);
 if(bytes!==entry.bytes||h.digest('hex')!==entry.sha256)fail('CORRUPT');
}
async function objectFor(file,entry,base,root,verified){
 const object=objectPath(base,entry.sha256);await directory(path.dirname(object),root);
 try{await safePath(object,root);const st=await fs.lstat(object);if(!st.isFile()||st.nlink!==1)fail('OBJECT');if(verified.get(object)!==signature(st)){await decoded(object,entry);verified.set(object,signature(st));}return object;}catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=object+'.'+randomUUID()+'.tmp';
 try{
  await pipeline(createReadStream(file),createGzip({level:6}),createWriteStream(temp,{flags:'wx',mode:0o600}));
  await decoded(temp,entry);const fd=await fs.open(temp,'r');try{await fd.sync();}finally{await fd.close();}
  await fs.chmod(temp,0o400);await fs.rename(temp,object);
  const dir=await fs.open(path.dirname(object),'r');try{await dir.sync();}finally{await dir.close();}
  verified.set(object,signature(await fs.lstat(object)));
  return object;
 }finally{await fs.rm(temp,{force:true});}
}

export async function archiveHistoricalBulk(c,{runtime,audit,gate,openCheck,apply,protectedPaths,data}){
 const base=path.join(c.managedRoot,'.backup-content-store');
 const result={version:2,policy:'compressed-content-backup-v1',apply,removed:0,logicalBytes:0,objectsReferenced:0,manifests:[],protectedCheckpoints:[...protectedPaths],uniquePreserved:true,deferred:false};
 const before=await fs.statfs(runtime);
 const verifiedObjects=new Map();
 const check=async()=>{if(!await gate()){result.deferred=true;return false;}return true;};
 if(!await check())return result;
 if(apply){await directory(base,c.managedRoot);await directory(path.join(base,'manifests'),c.managedRoot);}
 for(const candidate of c.candidates){
  if(protectedPaths.has(candidate.checkpoint))continue;
  if(!await check())break;
  if(!await openCheck(candidate.checkpoint)){result.deferred=true;continue;}
  // Registry validation has already bound every root to this checkpoint's data.
  if(candidate.path!==path.join(data.get(candidate.checkpoint),candidate.kind))fail('ROOT');
  const manifestFile=path.join(base,'manifests',hash(candidate.checkpoint+'\0'+candidate.kind)+'.json');
  let manifest={version:1,policy:'compressed-content-backup-v1',checkpoint:candidate.checkpoint,root:candidate.path,kind:candidate.kind,entries:{}};
  if(apply)try{await safePath(manifestFile,c.managedRoot);manifest=JSON.parse(await fs.readFile(manifestFile));validateManifest(manifest,base,c.managedRoot);if(manifest.root!==candidate.path||manifest.checkpoint!==candidate.checkpoint)fail('IDENTITY');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(apply)for(const e of Object.values(manifest.entries)){
   if(!await check())break;
   const object=objectPath(base,e.sha256);await safePath(object,c.managedRoot);const stat=await fs.lstat(object);if(!stat.isFile()||stat.nlink!==1)fail('OBJECT');
   if(verifiedObjects.get(object)!==signature(stat)){await decoded(object,e);verifiedObjects.set(object,signature(stat));}
  }
  if(result.deferred)break;
  let pending=[];
  const flush=async()=>{
   if(!pending.length)return;
   manifest.updatedAt=new Date().toISOString();await atomicJson(manifestFile,manifest);
   for(const {file,object,digest,objectSig}of pending){
    const removed=await gate({checkpoint:candidate.checkpoint},()=>{
     for(const p of [file,object]){if(realpathSync(p)!==p)fail('SYMLINK');for(let q=p;q!==c.managedRoot;q=path.dirname(q))if(lstatSync(q).isSymbolicLink())fail('SYMLINK');}
     if(signature(lstatSync(file))!==digest.signature||signature(lstatSync(object))!==objectSig)return false;
     unlinkSync(file);return true;
    });
    if(!removed){result.deferred=true;break;}
    result.removed++;result.objectsReferenced++;
   }
   pending=[];
   await atomicJson(path.join(audit,'content-store-progress.json'),{at:new Date().toISOString(),checkpoint:candidate.checkpoint,kind:candidate.kind,removed:result.removed,logicalBytes:result.logicalBytes,deferred:result.deferred});
  };
  for await(const file of files(candidate.path)){
   if(!await check())break;
   await safePath(file,c.managedRoot);const stat=await fs.lstat(file);
   if(stat.nlink!==1)continue; // Never unlink shared inodes without provenance.
   const digest=await fileDigest(file),rel=path.relative(candidate.path,file);
   if(!relative(rel))fail('PATH');
   const entry={sha256:digest.sha256,bytes:digest.bytes,mode:digest.mode,mtimeMs:digest.mtimeMs};
   if(Object.hasOwn(manifest.entries,rel)&&JSON.stringify(manifest.entries[rel])!==JSON.stringify(entry))fail('SOURCE_CHANGED');
   result.logicalBytes+=entry.bytes;
   if(!apply)continue;
   const object=await objectFor(file,entry,base,c.managedRoot,verifiedObjects),objectSig=signature(await fs.lstat(object));
   // The journal must survive BEFORE the original bytes are removed. A crash
   // leaves either two identical copies or a verified object with a full index.
   Object.defineProperty(manifest.entries,rel,{value:entry,enumerable:true,writable:true,configurable:true});pending.push({file,object,digest,objectSig});
   if(pending.length>=256)await flush();
   if(result.deferred)break;
  }
  if(apply)await flush();
  if(apply&&Object.keys(manifest.entries).length){
   const manifestHash=hash(await fs.readFile(manifestFile));
   const pointer=path.join(data.get(candidate.checkpoint),candidate.kind+'.content-store.json');
   await atomicJson(pointer,{policy:manifest.policy,manifest:manifestFile,sha256:manifestHash,restore:'scripts/restore-backup-content.mjs MANIFEST NEW_EMPTY_DIRECTORY MANAGED_ROOT'});
   result.manifests.push({file:manifestFile,sha256:manifestHash,root:candidate.path,entries:Object.keys(manifest.entries).length});
  }
  if(result.deferred)break;
 }
 const after=await fs.statfs(runtime);result.observedFreeBytesChange=Number(after.bavail)*Number(after.bsize)-Number(before.bavail)*Number(before.bsize);result.logicalIsNotPhysical=true;
 await atomicJson(path.join(audit,'content-store-result.json'),result);return result;
}

function validateManifest(m,base,root){
 if(m.version!==1||m.policy!=='compressed-content-backup-v1'||!['exports','control-receipts'].includes(m.kind)||typeof m.root!=='string'||!m.entries||typeof m.entries!=='object'||Array.isArray(m.entries))fail('MANIFEST');
 if(!path.isAbsolute(m.checkpoint)||!m.checkpoint.startsWith(root+path.sep)||!m.root.startsWith(m.checkpoint+path.sep)||path.basename(m.root)!==m.kind||m.checkpoint.startsWith(base+path.sep))fail('MANIFEST_ROOT');
 if(path.normalize(m.checkpoint)!==m.checkpoint||!['runtime-data','stopped-runtime-data','data'].some(n=>m.root===path.join(m.checkpoint,n,m.kind)))fail('MANIFEST_ROOT');
 for(const [name,e]of Object.entries(m.entries)){if(!relative(name)||!Number.isSafeInteger(e.bytes)||e.bytes<0||!Number.isInteger(e.mode)||e.mode<0||e.mode>0o777||!Number.isFinite(e.mtimeMs))fail('ENTRY');objectPath(base,e.sha256);}
}
export async function restoreBackupContent(manifestFile,{destination,managedRoot}){
 await safePath(manifestFile,managedRoot);await safePath(destination,managedRoot);
 const base=path.join(managedRoot,'.backup-content-store');if(path.dirname(manifestFile)!==path.join(base,'manifests'))fail('MANIFEST_LOCATION');
 const m=JSON.parse(await fs.readFile(manifestFile));validateManifest(m,base,managedRoot);
 if(destination===base||destination.startsWith(base+path.sep)||destination===m.checkpoint||destination.startsWith(m.checkpoint+path.sep)||m.checkpoint.startsWith(destination+path.sep)||(await fs.readdir(destination)).length)fail('DESTINATION');
 let restored=0,bytes=0;
 for(const [rel,entry]of Object.entries(m.entries)){
  const object=objectPath(base,entry.sha256);await safePath(object,managedRoot);const st=await fs.lstat(object);if(!st.isFile()||st.nlink!==1)fail('OBJECT');
  const file=path.join(destination,rel);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await safePath(path.dirname(file),managedRoot);
  try{await decoded(object,entry,file);await fs.chmod(file,entry.mode);await fs.utimes(file,entry.mtimeMs/1000,entry.mtimeMs/1000);}catch(e){await fs.rm(file,{force:true});throw e;}
  restored++;bytes+=entry.bytes;
 }
 return {ok:true,restored,bytes,destination,originalCheckpointUntouched:true};
}
