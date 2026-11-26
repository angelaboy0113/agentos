import {queryEvidenceIdentity} from '../shared/query-evidence.js';
import {mkdir,readFile,writeFile,rename,readdir,lstat,realpath,rm,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {datasetHash as hash,datasetJsonParts,datasetJsonStats} from '../shared/dataset-json.js';
const valid=id=>/^dataset-[a-f0-9-]{36}$/.test(id);
export class DatasetCapacityError extends Error {constructor(message){super(message);this.code='DATASET_CAPACITY';}}
// Scope is fixed by the authorised environment, and root by the leased job. No model paths.
export class TaskDatasetStore {
 constructor(root,scope,{maxBytes=Number.MAX_SAFE_INTEGER,additionalScopes=[],chunkBytes=4_000_000,chunkThresholdBytes=16_000_000}={}){this.root=path.join(root,'datasets');this.scope=scope;this.scopes=new Set([scope,...additionalScopes]);this.maxBytes=maxBytes;this.chunkBytes=chunkBytes;this.chunkThresholdBytes=chunkThresholdBytes;}
 async list(){
  let names;try{names=await readdir(this.root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const out=[];for(const name of names.filter(n=>n.endsWith('.json')&&valid(n.slice(0,-5)))){
   try{const d=await this.get(name.slice(0,-5),{metadataOnly:true});out.push({datasetRef:d.id,columns:d.data.columns,numericColumns:d.data.numericColumns??[],queryIdentity:queryEvidenceIdentity(d.data),rowCount:d.storedRowCount??d.data.rows.length,dataHash:d.dataHash,readAt:d.readAt,createdAt:d.createdAt??null,historical:Date.now()-Date.parse(d.readAt)>86400000,snapshotId:d.snapshotId,complete:true,kind:d.data.reportDraft?'report_draft':d.data.inputEvidence?'input':d.data.derivation?'derived':'query',derivationKind:d.data.derivation?.kind??null,dependencies:datasetDependencies(d.data),queryHash:d.data.queryHash,queryDefinition:d.data.queryDefinition?{sql:d.data.queryDefinition.sql.slice(0,200),params:d.data.queryDefinition.params.slice(0,3).map(v=>v.slice(0,80)),limited:d.data.queryDefinition.sql.length>200||d.data.queryDefinition.params.length>3||d.data.queryDefinition.params.some(v=>v.length>80)}:undefined});}catch{/* Invalid/stale/different-scope artifacts are never usable. */}
  }return out;
 }
 async manifest(id,allowPartial){
  if(!valid(id))throw new Error('数据集引用无效');
  if((await lstat(this.root)).isSymbolicLink())throw new Error('数据集目录不能是符号链接');
  const file=path.join(this.root,id+'.json'),root=await realpath(this.root),actual=await realpath(file),info=await lstat(file);
  if(!actual.startsWith(root+path.sep)||!info.isFile()||info.isSymbolicLink())throw new Error('数据集文件校验未通过');
  const d=JSON.parse(await readFile(file,'utf8'));
  if(d.id!==id||!this.scopes.has(d.scope)||!Number.isFinite(Date.parse(d.readAt))||Date.parse(d.readAt)>Date.now()+1000||d.data?.complete!==true&&!(allowPartial&&d.data?.complete===false)||!Array.isArray(d.data.columns)||!Array.isArray(d.data.rows))throw new Error('数据集范围、完整性、有效期或摘要校验失败');
  return {d,root};
 }
 async *validatedParts(d,root){
  const storage=d.storage;
  if(storage.format!=='rows-chunks-v1'||!Array.isArray(storage.parts)||!Number.isSafeInteger(storage.rowCount)||storage.rowCount<0||d.data.rows.length||hash(d.data)!==storage.metadataHash)throw new Error('分块数据集清单无效');
  let count=0;
  for(const [index,part] of storage.parts.entries()){
   if(part.name!==d.id+'.rows-'+String(index).padStart(6,'0')+'.json'||!Number.isSafeInteger(part.rows)||part.rows<1||!Number.isSafeInteger(part.bytes)||part.bytes<2)throw new Error('分块路径或数量无效');
   const chunk=path.join(this.root,part.name),actualChunk=await realpath(chunk),ci=await lstat(chunk);
   if(!actualChunk.startsWith(root+path.sep)||!ci.isFile()||ci.isSymbolicLink()||ci.size!==part.bytes)throw new Error('分块文件边界或大小校验失败');
   const text=await readFile(chunk,'utf8');
   if(createHash('sha256').update(text).digest('hex')!==part.sha256)throw new Error('分块摘要校验失败');
   count+=part.rows;
   yield {text,part};
  }
  if(count!==storage.rowCount)throw new Error('分块覆盖不完整');
 }
 async openRows(id,{check=async()=>{}}={}){
  const {d,root}=await this.manifest(id,false);
  const data={...d.data,rows:[],readAt:d.readAt,snapshotId:d.snapshotId};
  const store=this;
  return {data,scope:d.scope,rowCount:d.storage?.rowCount??d.data.rows.length,async *rows(){
   await check();
   if(!d.storage){
    if(hash(d.data)!==d.dataHash)throw new Error('数据集摘要校验失败');
    yield* d.data.rows;
    return;
   }
   const digest=rowDigest(d.data);
   for await(const {text,part} of store.validatedParts(d,root)){
    await check();
    const rows=parseRows(text,part);
    digest.add(text);
    yield* rows;
   }
   if(digest.finish()!==d.dataHash)throw new Error('分块完整数据摘要校验失败');
   await check();
  }};
 }
 async get(id,{allowPartial=false,metadataOnly=false,range}={}){
  const {d,root}=await this.manifest(id,allowPartial);
  if(d.storage){
   let count=0;
   const digest=range?rowDigest(d.data):null;
   for await(const {text,part} of this.validatedParts(d,root)){
    digest?.add(text);
    const before=count;
    count+=part.rows;
    if(!metadataOnly&&(!range||range.limit>0&&range.offset<count&&range.offset+range.limit>before)){
     const rows=parseRows(text,part);
     const selected=range?rows.slice(Math.max(0,range.offset-before),range.offset+range.limit-before):rows;
     for(const row of selected)d.data.rows.push(row);
    }
   }
   d.storedRowCount=count;
   if((digest?digest.finish():!metadataOnly?hash(d.data):d.dataHash)!==d.dataHash)throw new Error('分块完整数据摘要校验失败');
  }else if(hash(d.data)!==d.dataHash)throw new Error('数据集摘要校验失败');
  if(range&&!d.storage){d.storedRowCount=d.data.rows.length;d.data.rows=d.data.rows.slice(range.offset,range.offset+range.limit);}
  return d;
 }
 async storageUsed(id){
  if(!valid(id))throw new Error('数据集引用无效');
  await mkdir(this.root,{recursive:true,mode:0o700});
  if((await lstat(this.root)).isSymbolicLink())throw new Error('数据集目录不能是符号链接');
  // Count actual disk bytes, including stale/invalid artifacts; never evict referenced evidence.
  const names=await readdir(this.root);let used=0;for(const name of names){const info=await lstat(path.join(this.root,name));if(info.isFile())used+=info.size;}
  return used;
 }
 async save(id,data,snapshotId,readAt=new Date().toISOString()){
  const used=await this.storageUsed(id);
  const stats=datasetJsonStats(data),d={id,scope:this.scope,readAt,createdAt:new Date().toISOString(),snapshotId,dataHash:stats.hash,data};
  if(stats.bytes>this.chunkThresholdBytes&&Array.isArray(data.rows)){
   await this.writeChunks(id,data.rows,used,()=>({...d,data:{...d.data,rows:[]}}));
   return d;
  }
  const text=JSON.stringify(d);
  if(used+Buffer.byteLength(text)>this.maxBytes)throw new DatasetCapacityError('任务数据集实际磁盘容量不足；已有成果保留。先list_datasets复用并修正已有草稿，不重复全量取数；确需更多数据时由维护者评估容量。');
  const temp=path.join(this.root,id+'.tmp'),file=path.join(this.root,id+'.json');
  try{await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,file);}catch(e){await rm(temp,{force:true});throw e;}
  return d;
 }
 async saveRows(id,rows,finish){
  const used=await this.storageUsed(id);
  return this.writeChunks(id,rows,used,()=>{
   const data=finish([]);
   return {id,scope:this.scope,readAt:data.readAt,createdAt:new Date().toISOString(),snapshotId:data.snapshotId,data};
  });
 }
 async writeChunks(id,rows,used,finish){
  const parts=[],created=[],temp=path.join(this.root,id+'.tmp');let pending=[],bytes=2,written=0,rowCount=0;
  const flush=async()=>{if(!pending.length)return;const text='['+pending.join(',')+']',size=Buffer.byteLength(text);if(used+written+size>this.maxBytes)throw new DatasetCapacityError('任务数据集实际磁盘容量不足；已有成果保留。');const name=id+'.rows-'+String(parts.length).padStart(6,'0')+'.json',file=path.join(this.root,name),handle=await open(file,'wx',0o600);created.push(file);try{await handle.writeFile(text);}finally{await handle.close();}parts.push({name,bytes:size,rows:pending.length,sha256:createHash('sha256').update(text).digest('hex')});written+=size;rowCount+=pending.length;pending=[];bytes=2;};
  try{
   for await(const row of rows){const text=JSON.stringify(row)??'null',size=Buffer.byteLength(text)+1;if(pending.length&&(bytes+size>this.chunkBytes||pending.length>=10000))await flush();pending.push(text);bytes+=size;}await flush();
   const header=finish();
   if(!header.dataHash){
    const digest=rowDigest(header.data);
    for(const file of created)digest.add(await readFile(file,'utf8'));
    header.dataHash=digest.finish();
   }
   header.storage={format:'rows-chunks-v1',rowCount,metadataHash:hash(header.data),parts};
   const text=JSON.stringify(header);if(used+written+Buffer.byteLength(text)>this.maxBytes)throw new DatasetCapacityError('任务数据集实际磁盘容量不足；已有成果保留。');await writeFile(temp,text,{flag:'wx',mode:0o600});await rename(temp,path.join(this.root,id+'.json'));return header;
  }catch(error){await rm(temp,{force:true});for(const file of created)await rm(file,{force:true});throw error;}
 }

}

function parseRows(text,part){
 const rows=JSON.parse(text);
 if(!Array.isArray(rows)||rows.length!==part.rows)throw new Error('分块行数校验失败');
 return rows;
}

// Reconstruct the existing JSON digest over the stored row arrays without
// materializing the rows or a single full-size JSON string.
function rowDigest(data){
 const parts=datasetJsonParts(data),digest=createHash('sha256');
 for(let step=parts.next();!step.done;step=parts.next()){
  const part=step.value;
  digest.update(part);
  if(part==='"rows":'){
   if(parts.next().value!=='['||parts.next().value!==']')throw Error('分块数据集清单无效');
   digest.update('[');
   break;
  }
 }
 let first=true;
 return {
  add(text){if(!first)digest.update(',');digest.update(text.slice(1,-1));first=false;},
  finish(){digest.update(']');for(const part of parts)digest.update(part);return digest.digest('hex');},
 };
}

export function datasetDependencies(data){
 const d=data.derivation;
 return [...new Set([...(data.reportDraft?.sources??[]).map(s=>s.datasetRef),...(data.reportDraft?.population?[data.reportDraft.population.datasetRef]:[]),...(['period_grid','window_counts'].includes(d?.kind)?[d.args.populationRef,...d.args.sources.map(s=>s.datasetRef)]:d?.kind==='dataset_relation'?[d.args.datasetRef,...d.args.joins.map(j=>j.datasetRef)]:d?.kind==='left_lookup'?[d.datasetRef,...d.lookups.map(s=>s.datasetRef)]:['dataset_summary','dataset_transform','dimension_extension','random_sample'].includes(d?.kind)?[d.args.datasetRef]:[])])];
}
