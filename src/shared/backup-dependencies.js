// Compact only byte-identical dependency trees of already accepted old backups.
import fs from 'node:fs/promises';import path from 'node:path';
import {renameSync,lstatSync,realpathSync} from 'node:fs';import {randomUUID,createHash} from 'node:crypto';
import {safePath,checkedRegistry,dependencyDigest,atomicJson,noOpenFiles,fileDigest} from './maintenance-backups.js';
async function present(p){try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function checkedTree(p,managedRoot){await safePath(p,managedRoot);if((await fs.lstat(p)).isSymbolicLink()||!await fs.stat(p).then(s=>s.isDirectory()))throw Error('MAINTENANCE_DEPENDENCY_TREE');}
// npm changes only its root install receipt across application versions. Keep
// that exact small receipt in the ledger; compare every package byte/link/mode.
export async function dependencyPayloadDigest(root){
 const hash=createHash('sha256');
 async function walk(dir){for(const e of(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name),rel=path.relative(root,f);if(dir===root&&e.name==='.package-lock.json'){if(!e.isFile())throw Error('MAINTENANCE_DEPENDENCY_METADATA');continue;}const st=await fs.lstat(f);if(e.isDirectory())await walk(f);else if(e.isSymbolicLink())hash.update(JSON.stringify([rel,'link',await fs.readlink(f)]));else if(e.isFile())hash.update(JSON.stringify([rel,st.mode&0o777,(await fileDigest(f)).sha256]));else throw Error('MAINTENANCE_DEPENDENCY_TREE');}}
 await walk(root);return hash.digest('hex');
}
async function metadata(root){const file=path.join(root,'.package-lock.json');try{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw Error('MAINTENANCE_DEPENDENCY_METADATA');return {base64:(await fs.readFile(file)).toString('base64'),mode:st.mode&0o777};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function compactBackupDependencies(c,{runtime,audit,gate,apply=false,openCheck=noOpenFiles}={}){
 const pinsFile=path.join(runtime,'maintenance-backups/anchor-pins.json');let pins=[];try{pins=JSON.parse(await fs.readFile(pinsFile));}catch(e){if(e.code!=='ENOENT')throw e;}if(!Array.isArray(pins))throw Error('MAINTENANCE_PINS');c={...c,pins:[...new Set([...c.pins,...pins])]};
 const {protectedPaths}=await checkedRegistry(c,runtime);await safePath(audit,c.managedRoot);
 const result={version:1,kind:'backup-dependencies',apply,removedTrees:0,uniqueTreesPreserved:0,deferred:false,plans:[]};
 const anchors=[];
 // Only complete retained checkpoints anchor deduplication; never a live install.
 for(const checkpoint of protectedPaths){const tree=path.join(checkpoint,'node_modules');if(!await present(tree))continue;await checkedTree(tree,c.managedRoot);anchors.push({tree,checkpoint});}
 const digests=new Map();const digest=async p=>{if(!digests.has(p))digests.set(p,await dependencyPayloadDigest(p));return digests.get(p);};
 for(const b of c.checkpoints){
  if(protectedPaths.has(b.path))continue;if(!await gate()){result.deferred=true;break;}
  const tree=path.join(b.path,'node_modules');if(!await present(tree))continue;await checkedTree(tree,c.managedRoot);
  if(!await openCheck(b.path)){result.deferred=true;continue;}
  const expected=await digest(tree);let match;
  for(const a of anchors){if(!await gate()){result.deferred=true;break;}if(await digest(a.tree)===expected){match=a;break;}}
  if(result.deferred)break;if(!match){result.uniqueTreesPreserved++;continue;}
  const retired=path.join(audit,'retired-backup-dependencies-'+randomUUID());
  const originalSha=await dependencyDigest(tree),retainedSha=await dependencyDigest(match.tree);
  const plan={retired,version:1,kind:'backup-dependencies',original:tree,checkpoint:b.path,retained:match.tree,retainedCheckpoint:match.checkpoint,sha256:originalSha,payloadSha256:expected,retainedSha256:retainedSha,metadata:await metadata(tree)};
  if(!apply){result.plans.push(plan);continue;}
  const ledger=path.join(audit,'dependency-'+randomUUID()+'.json');await atomicJson(ledger,plan);pins=[...new Set([...pins,match.checkpoint])];await atomicJson(pinsFile,pins);
  if(!await openCheck(b.path)||await dependencyDigest(tree)!==originalSha||await dependencyDigest(match.tree)!==retainedSha)throw Error('MAINTENANCE_DEPENDENCY_CHANGED');
  const moved=await gate({checkpoint:b.path},()=>{if(realpathSync(tree)!==tree||!lstatSync(tree).isDirectory())throw Error('MAINTENANCE_SYMLINK');renameSync(tree,retired);return true;});
  if(!moved){result.deferred=true;break;}
  if(await dependencyDigest(retired)!==originalSha)throw Error('MAINTENANCE_DEPENDENCY_QUARANTINED');
  await atomicJson(tree+'.restore.json',{...plan,ledger});await fs.rm(retired,{recursive:true});result.removedTrees++;result.plans.push(ledger);
 }
 return result;
}
export async function restoreBackupDependencies(ledger,{managedRoot,destination}={}){
 await safePath(ledger,managedRoot);const p=JSON.parse(await fs.readFile(ledger));if(p.version!==1||p.kind!=='backup-dependencies'||!p.retainedCheckpoint||p.retained!==path.join(p.retainedCheckpoint,'node_modules')||p.original!==path.join(p.checkpoint,'node_modules'))throw Error('MAINTENANCE_DEPENDENCY_PLAN');
 await checkedTree(p.retained,managedRoot);await safePath(destination,managedRoot);if((await fs.readdir(destination)).length||destination.startsWith(p.checkpoint+path.sep)||destination.startsWith(p.retainedCheckpoint+path.sep))throw Error('MAINTENANCE_RESTORE_DESTINATION');
 if(await dependencyDigest(p.retained)!==(p.retainedSha256??p.sha256))throw Error('MAINTENANCE_ANCHOR_CHANGED');
 // cp preserves symlinks rather than dereferencing package binaries.
 for(const name of (await fs.readdir(p.retained)).filter(n=>n!=='.package-lock.json'))await fs.cp(path.join(p.retained,name),path.join(destination,name),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
 if(p.metadata)await fs.writeFile(path.join(destination,'.package-lock.json'),Buffer.from(p.metadata.base64,'base64'),{mode:p.metadata.mode,flag:'wx'});
 if(await dependencyDigest(destination)!==p.sha256)throw Error('MAINTENANCE_RESTORE_HASH');return {restored:true,hashesVerified:true};
}
