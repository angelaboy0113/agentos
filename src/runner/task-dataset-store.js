import {mkdir,readFile,writeFile,rename,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const valid=id=>/^dataset-[a-f0-9-]{36}$/.test(id);
// Scope is fixed by the authorised environment, and root by the leased job. No model paths.
export class TaskDatasetStore {
 constructor(root,scope){this.root=path.join(root,'datasets');this.scope=scope;}
 async list(){
  let names;try{names=await readdir(this.root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const out=[];for(const name of names.filter(n=>n.endsWith('.json')&&valid(n.slice(0,-5))).slice(0,64)){
   try{const d=await this.get(name.slice(0,-5));out.push({datasetRef:d.id,columns:d.data.columns,rowCount:d.data.rows.length,dataHash:d.dataHash,readAt:d.readAt,snapshotId:d.snapshotId,complete:true});}catch{/* Invalid/stale/different-scope artifacts are never usable. */}
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
  const existing=await this.list();if(existing.length>=24)throw new Error('任务内最多持久保留24个完整数据集，不能重复取数无限增长');
  const d={id,scope:this.scope,readAt,snapshotId,dataHash:hash(data),data};
  const text=JSON.stringify(d);if(Buffer.byteLength(text)>16_000_000)throw new Error('单个任务数据集超过16MB');
  let bytes=Buffer.byteLength(text);for(const old of existing){bytes+=(await lstat(path.join(this.root,old.datasetRef+'.json'))).size;}if(bytes>32_000_000)throw new Error('任务数据集累计超过32MB');
  const temp=path.join(this.root,id+'.tmp'),file=path.join(this.root,id+'.json');
  try{await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,file);}catch(e){await rm(temp,{force:true});throw e;}
  return d;
 }
}
