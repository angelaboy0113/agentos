import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
export const CONTROL_PROTOCOL='durable-control-v1';
export const validRequestId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const controlDigest=(route,body)=>createHash('sha256').update(JSON.stringify([route,body])).digest('hex');
export function criticalControl(route,body){return route==='/api/v1/jobs/lease'||/^\/api\/v1\/jobs\/[^/]+\/(?:environment-claim|environment-renew|continuous-environment|continuous-environment-result|continuous-analysis-continue)$/.test(route)||/^\/api\/v1\/jobs\/[^/]+\/events$/.test(route)&&!['heartbeat','progress'].includes(body.type);}
const conflict=()=>Object.assign(new Error('Control request identity mismatch'),{statusCode:409});
export class ControlReceipts{
 constructor(store){this.store=store;this.directory=path.join(path.dirname(store.file),'control-receipts');this.pending=new Map();}
 async directoryReady(){await mkdir(this.directory,{recursive:true,mode:0o700});if((await lstat(this.directory)).isSymbolicLink()||path.dirname(await realpath(this.directory))!==await realpath(path.dirname(this.store.file)))throw new Error('Invalid control receipt directory');}
 check(saved,meta){if(saved.digest!==meta.digest||saved.runnerId!==meta.runnerId)throw conflict();}
 async committed(meta){const saved=(await this.store.snapshot()).controlReceipts?.[meta.id];if(!saved)return null;this.check(saved,meta);await this.directoryReady();const file=path.join(this.directory,meta.id+'.json');if((await lstat(file)).isSymbolicLink())throw new Error('Invalid control receipt file');const raw=await readFile(file);if(createHash('sha256').update(raw).digest('hex')!==saved.sha256)throw new Error('Control receipt missing or corrupt; automatic replay refused');return JSON.parse(raw);}
 async commit(meta,operation){
  if(!meta)return operation();
  return this.store.transact(async state=>{
   if(state.controlReceipts?.[meta.id]){return this.committed(meta);}
   const scope={state,active:true};let response;try{response=await this.store.transactionContext.run(scope,operation);}finally{scope.active=false;}
   await this.directoryReady();const file=path.join(this.directory,meta.id+'.json'),temporary=file+'.tmp';const raw=JSON.stringify(response);
   await writeFile(temporary,raw,{mode:0o600});await rename(temporary,file);
   state.controlReceipts??={};state.controlReceipts[meta.id]={digest:meta.digest,runnerId:meta.runnerId,route:meta.route,leaseId:meta.leaseId,jobId:meta.jobId,executable:meta.executable,sha256:createHash('sha256').update(raw).digest('hex'),at:new Date().toISOString()};
   return structuredClone(response);
  }).catch(error=>{error.controlReceiptFailure=true;throw error;});
 }
}
