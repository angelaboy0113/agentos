import {mkdir,readFile,writeFile,rename,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const valid=id=>/^dataset-[a-f0-9-]{36}$/.test(id);
export class DatasetCapacityError extends Error {constructor(message){super(message);this.code='DATASET_CAPACITY';}}
// Scope is fixed by the authorised environment, and root by the leased job. No model paths.
export class TaskDatasetStore {
 constructor(root,scope,{maxBytes=32_000_000}={}){this.root=path.join(root,'datasets');this.scope=scope;this.maxBytes=maxBytes;}
 async list(){
  let names;try{names=await readdir(this.root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const out=[];for(const name of names.filter(n=>n.endsWith('.json')&&valid(n.slice(0,-5)))){
   try{const d=await this.get(name.slice(0,-5));out.push({datasetRef:d.id,columns:d.data.columns,rowCount:d.data.rows.length,dataHash:d.dataHash,readAt:d.readAt,snapshotId:d.snapshotId,complete:true,kind:d.data.reportDraft?'report_draft':d.data.derivation?'derived':'query',queryHash:d.data.queryHash,queryDefinition:d.data.queryDefinition?{sql:d.data.queryDefinition.sql.slice(0,200),params:d.data.queryDefinition.params.slice(0,3).map(v=>v.slice(0,80)),limited:d.data.queryDefinition.sql.length>200||d.data.queryDefinition.params.length>3||d.data.queryDefinition.params.some(v=>v.length>80)}:undefined});}catch{/* Invalid/stale/different-scope artifacts are never usable. */}
  }return out;
 }
 async get(id){
  if(!valid(id))throw new Error('数据集引用无效');
  if((await lstat(this.root)).isSymbolicLink())throw new Error('数据集目录不能是符号链接');
  const file=path.join(this.root,id+'.json'),root=await realpath(this.root),actual=await realpath(file),info=await lstat(file);
  if(!actual.startsWith(root+path.sep)||!info.isFile()||info.isSymbolicLink()||info.size>16_000_000)throw new Error('数据集文件校验未通过');
  const d=JSON.parse(await readFile(file,'utf8'));
  if(d.id!==id||d.scope!==this.scope||!Number.isFinite(Date.parse(d.readAt))||Date.now()-Date.parse(d.readAt)>86400000||Date.parse(d.readAt)>Date.now()+1000||d.data?.complete!==true||!Array.isArray(d.data.columns)||!Array.isArray(d.data.rows)||d.data.rows.length>10000||hash(d.data)!==d.dataHash)throw new Error('数据集范围、完整性、有效期或摘要校验失败');
  return d;
 }
 async save(id,data,snapshotId,readAt=new Date().toISOString()){
  await mkdir(this.root,{recursive:true,mode:0o700});
  if((await lstat(this.root)).isSymbolicLink())throw new Error('数据集目录不能是符号链接');
  // Count actual disk bytes, including stale/invalid artifacts; never evict referenced evidence.
  const names=await readdir(this.root);let used=0;for(const name of names){const info=await lstat(path.join(this.root,name));if(info.isFile())used+=info.size;}
  const d={id,scope:this.scope,readAt,snapshotId,dataHash:hash(data),data};
  const text=JSON.stringify(d);if(Buffer.byteLength(text)>16_000_000)throw new DatasetCapacityError('单个任务数据集超过16MB；按业务维度分组或减少非必要列，已有成果保留');
  if(used+Buffer.byteLength(text)>this.maxBytes)throw new DatasetCapacityError('任务数据集实际磁盘容量不足；已有成果保留。先list_datasets复用并修正已有草稿，不重复全量取数；确需更多数据时由维护者评估容量。');
  const temp=path.join(this.root,id+'.tmp'),file=path.join(this.root,id+'.json');
  try{await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,file);}catch(e){await rm(temp,{force:true});throw e;}
  return d;
 }
}
