// Local operator CLI. No credentials, message bodies, business queries or service stop.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {atomicJson,safePath,dependencyDigest,restorePlan,validateRegistry,acquire} from '../src/shared/maintenance-backups.js';
const [action,runtimeArg,arg,extra]=process.argv.slice(2),runtime=path.resolve(runtimeArg??'.'),file=path.join(runtime,'maintenance-cleanup.local.json'),root=path.join(runtime,'migration');
const sha=b=>createHash('sha256').update(b).digest('hex');
if(action==='restore-fragments'){
 const release=await acquire(root);if(!release)throw Error('Maintenance locked');try{console.log(JSON.stringify(await restorePlan(path.resolve(arg),{destination:path.resolve(extra),managedRoot:root})));}finally{await release();}
}else if(['register-checkpoint','register-test'].includes(action)){
 const release=await acquire(root);if(!release)throw Error('Maintenance locked');
 try{const c=validateRegistry(JSON.parse(await fs.readFile(file)),runtime),proofPath=path.resolve(action==='register-test'?extra:arg);await safePath(proofPath,root);const raw=await fs.readFile(proofPath);
 // Deployment acceptance and test logs can acquire later annotations. Freeze the
 // exact reviewed bytes, rather than trusting a mutable operator report forever.
 const proofs=path.join(root,'.maintenance-proofs');await fs.mkdir(proofs,{recursive:true,mode:0o700});await safePath(proofs,root);
 const immutable=path.join(proofs,sha(raw)+'.json');try{const fd=await fs.open(immutable,'wx',0o600);try{await fd.writeFile(raw);await fd.sync();}finally{await fd.close();}}catch(e){if(e.code!=='EEXIST')throw e;await safePath(immutable,root);if(sha(await fs.readFile(immutable))!==sha(raw))throw Error('MAINTENANCE_PROOF_CHANGED');}
 const proof={path:immutable,sha256:sha(raw)};
 if(action==='register-checkpoint'){
  const acceptance=JSON.parse(raw);if(!acceptance.health||acceptance.ready<1||!acceptance.backup||!acceptance.commit||!acceptance.version||!Number.isFinite(Date.parse(acceptance.at)))throw Error('Accepted deployment proof required');
  await safePath(acceptance.backup,root);if(!c.checkpoints.some(b=>b.path===acceptance.backup))c.checkpoints.push({path:acceptance.backup,acceptedAt:acceptance.at,proof});
  // Each newly accepted backup registers only its bulk subdirectories. Latest three
  // stay whole; all previously used anchors are permanent pins until manual rebasing.
  for(const kind of ['exports','control-receipts']){let bulk;for(const d of ['runtime-data','stopped-runtime-data','data']){try{const p=path.join(acceptance.backup,d,kind);await safePath(p,root);bulk=p;break;}catch(e){if(e.code!=='ENOENT')throw e;}}if(bulk&&!c.candidates.some(x=>x.path===bulk))c.candidates.push({checkpoint:acceptance.backup,path:bulk,kind});}
  c.acceptedRelease={version:acceptance.version,id:acceptance.commit};
 }else{
  const p=path.resolve(arg);await safePath(p,root);if(path.basename(p)!=='node_modules'||!/# pass [1-9]\d*\b/.test(raw.toString())||!/# fail 0\b/.test(raw.toString()))throw Error('Completed clean test proof required');
  c.testTrees??=[];c.testTrees=c.testTrees.filter(x=>x.path!==p);c.testTrees.push({path:p,sha256:await dependencyDigest(p),proof});
 }
 await atomicJson(file,c);console.log(JSON.stringify({ok:true,registered:action}));}finally{await release();}
}else throw Error('Usage: node scripts/maintenance-backups.mjs register-checkpoint RUNTIME ACCEPTANCE | register-test RUNTIME NODE_MODULES TEST_LOG | restore-fragments RUNTIME PLAN_GZ NEW_EMPTY_DIRECTORY');
