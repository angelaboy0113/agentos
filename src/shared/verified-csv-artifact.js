import {createHash,randomUUID} from 'node:crypto';
import {rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readArtifactFile} from './artifact-workspace.js';
import {reportFile} from './report-files.js';
import {encodeReportCsv,reportCsv} from './report-revision.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const strings=values=>Array.isArray(values)&&values.length>0&&values.every(v=>typeof v==='string');
const fail=message=>{throw Object.assign(new Error(message),{code:'DOCUMENT_INPUT'});};

function boundSource(job,id){
 const current=job.reportFiles?.find(f=>f.id===id);
 if(current?.kind!=='document'&&current?.filename?.endsWith('.csv'))return {...current,sourceJobId:current.sourceJobId??job.id};
 const source=job.attachments?.map(a=>a.source).find(s=>s?.kind==='delivered-report'&&s.report?.id===id);
 if(source&&source.projectId===job.projectId&&source.chatId===job.chatId&&source.originProfile===(job.originProfile??job.agentProfile)
  &&(!source.sourceEnvironment||source.sourceEnvironment===job.sourceEnvironment)&&source.sha256===source.report.sha256&&source.report.kind!=='document'&&source.report.filename.endsWith('.csv')){
  return {...source.report,sourceJobId:source.sourceJobId};
 }
 fail('CSV来源必须是本任务已登记或者同话题当前有权读取的已核验CSV');
}

async function rowsFromSource(dataDir,rule,source,headers){
 if(!fields(rule,['fileId','filters','columns'])||!Array.isArray(rule.filters)||!Array.isArray(rule.columns)||rule.columns.length!==headers.length)fail('CSV配方每个来源须提供精确筛选和与输出表头对应的列映射');
 const saved=await reportFile(dataDir,source.sourceJobId,source,{includeReceipt:true});
 const table=reportCsv(saved.content);
 if(table.rows.length!==source.rowCount)fail('CSV来源实际行数与核验登记不一致');
 const index=name=>table.headers.indexOf(name);
 const filters=rule.filters.map(f=>{
  if(!fields(f,['column','values'])||index(f.column)<0||!strings(f.values))fail('CSV筛选须声明实际列及精确字符串集合');
  return [index(f.column),new Set(f.values)];
 });
 const project=rule.columns.map(c=>{
  if(!fields(c,['from','constant','meta'])||Object.keys(c).length!==1)fail('CSV列来源只能是原始列、明确标签或来源位置');
  if(index(c.from)>=0)return row=>row[index(c.from)];
  if(typeof c.constant==='string')return ()=>c.constant;
  if(c.meta==='filename')return ()=>source.filename;
  if(c.meta==='rowNumber')return (_row,i)=>String(i+2);
  if(c.meta==='recordJson')return row=>'{'+table.headers.map((name,i)=>JSON.stringify(name)+': '+JSON.stringify(row[i])).join(', ')+'}';
  fail('CSV投影引用未知列或来源字段');
 });
 const rows=[];
 for(const [i,row] of table.rows.entries())if(filters.every(([column,values])=>values.has(row[column])))rows.push(project.map(p=>p(row,i)));
 return {rows,sources:{fileId:source.id,sourceJobId:source.sourceJobId,sha256:source.sha256,inputRows:table.rows.length,matchedRows:rows.length,readWindow:saved.receipt.readWindow??null}};
}

async function replay(dataDir,recipe,sourceFiles){
 const {headers,sources,group}=recipe;
 if(!fields(recipe,['headers','sources','group'])||!strings(headers)||new Set(headers).size!==headers.length||headers.some(x=>!x.trim()||/^[\s\uFEFF]*[=+@-]/.test(x))
  ||!Array.isArray(sources)||!sources.length||new Set(sources.map(s=>s?.fileId)).size!==sources.length||sourceFiles.length!==sources.length)fail('CSV配方需要唯一表头和不重复的已核验来源');
 const rows=[],coverage=[];
 for(const [i,rule] of sources.entries()){
  if(sourceFiles[i].id!==rule.fileId)fail('CSV配方与绑定来源不一致');
  const result=await rowsFromSource(dataDir,rule,sourceFiles[i],headers);
  for(const row of result.rows)rows.push(row);
  coverage.push(result.sources);
 }
 if(group===undefined)return {headers,rows,coverage};
 if(!fields(group,['keys','collect','label','separator'])||!strings(group.keys)||new Set(group.keys).size!==group.keys.length
  ||group.keys.some(k=>!headers.includes(k))||!headers.includes(group.collect)||group.keys.includes(group.collect)
  ||typeof group.label!=='string'||!group.label.trim()||group.keys.includes(group.label)||/^[\s\uFEFF]*[=+@-]/.test(group.label)||typeof group.separator!=='string'||!group.separator)fail('CSV汇总须显式指定去重键、汇集字段和分隔符');
 const keys=group.keys.map(x=>headers.indexOf(x)),index=headers.indexOf(group.collect),groups=new Map();
 for(const row of rows){
  const key=keys.map(i=>row[i]),id=JSON.stringify(key);
  if(!groups.has(id))groups.set(id,{key,choices:new Set()});
  groups.get(id).choices.add(row[index]);
 }
 const output=[...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,x])=>[...x.key,[...x.choices].sort().join(group.separator)]);
 return {headers:[...group.keys,group.label],rows:output,coverage};
}

function csvBytes(headers,rows){
 return encodeReportCsv(headers,rows.map(row=>row.map(value=>/^[\s\uFEFF]*[=+@-]/.test(value)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(value)?"'"+value:value)));
}

export async function createVerifiedCsvArtifact(dataDir,directory,job,request){
 if(typeof request.content!=='string')fail('业务CSV登记需要JSON字符串，声明 artifactFile、headers、sources 和可选 group；CSV须按已核验来源重放并独立核验');
 let spec;
 try{spec=JSON.parse(request.content);}catch{fail('业务CSV登记须提供可重放JSON来源配方，直接文本或工作区文件本身不能充当依据');}
 if(!fields(spec,['artifactFile','headers','sources','group'])||typeof spec.artifactFile!=='string'||!Array.isArray(spec.sources))fail('业务CSV配方需要 artifactFile、headers 与 sources');
 const {artifactFile,...recipe}=spec,sourceFiles=recipe.sources.map(rule=>boundSource(job,rule?.fileId));
 const result=await replay(dataDir,recipe,sourceFiles);
 const raw=await readArtifactFile(dataDir,job.id,artifactFile);
 const actual=reportCsv(raw.bytes);
 if(!isDeepStrictEqual(actual.headers,result.headers)||!isDeepStrictEqual(actual.rows,result.rows))fail('实际CSV表头、行序或单元格与完整来源重放结果不一致');
 const id='report-'+randomUUID(),filename=id+'.csv',bytes=csvBytes(result.headers,result.rows);
 const item={id,filename,format:'csv',title:request.title,bytes:bytes.length,sha256:digest(bytes),rowCount:result.rows.length,complete:true};
 const receipt={version:1,status:'verified',file:item,coverage:{rowCount:item.rowCount},csvArtifact:{version:1,recipe,sourceFiles,coverage:result.coverage,artifactSha256:raw.sha256},purpose:request.purpose};
 const body=Buffer.from(JSON.stringify(receipt)),file=path.join(directory,filename);
 await writeFile(file,bytes,{mode:0o600,flag:'wx'});
 try{await writeFile(path.join(directory,id+'.verification.json'),body,{mode:0o600,flag:'wx'});}
 catch(error){await rm(file);throw error;}
 return {...item,verificationHash:digest(body)};
}

export async function inspectVerifiedCsvArtifact(dataDir,job,item,saved,args){
 const proof=saved.receipt.csvArtifact;
 if(proof.version!==1)fail('CSV配方版本无效');
 const table=await replay(dataDir,proof.recipe,proof.sourceFiles);
 if(!csvBytes(table.headers,table.rows).equals(saved.content)||!isDeepStrictEqual(table.coverage,proof.coverage)||table.rows.length!==item.rowCount)fail('实际CSV与持久化来源或配方不一致');
 const binding={sourceJobId:item.sourceJobId??job.id,fileId:item.id,sha256:item.sha256,verificationHash:item.verificationHash,rowCount:item.rowCount};
 const calculationAudit={status:'passed',checkedRows:table.rows.length,checkedCells:table.rows.length*table.headers.length};
 if(args.section==='rows'){
  const headers=args.columns??table.headers;
  if(!strings(headers)||new Set(headers).size!==headers.length||headers.some(h=>!table.headers.includes(h)))fail('请选择实际CSV表头');
  const indices=headers.map(h=>table.headers.indexOf(h)),actual=reportCsv(saved.content);
  const items=[];let size=0;
  for(let i=args.offset;i<Math.min(actual.rows.length,args.offset+args.limit);i++){
   const row={rowNumber:i+1,values:indices.map(k=>actual.rows[i][k])};
   size+=Buffer.byteLength(JSON.stringify(row));if(items.length&&size>16000)break;
   items.push(row);
  }
  return {binding,section:args.section,headers,items,totalCount:actual.rows.length,nextOffset:args.offset+items.length<actual.rows.length?args.offset+items.length:null,calculationAudit};
 }
 const entries=args.section==='sources'?table.coverage:args.section==='columns'?table.headers:args.section==='checks'?[calculationAudit]:args.section==='scope'?table.coverage:[];
 if(args.section!=='summary')return {binding,section:args.section,items:entries.slice(args.offset,args.offset+args.limit),totalCount:entries.length,nextOffset:args.offset+args.limit<entries.length?args.offset+args.limit:null,calculationAudit};
 return {status:'verified',binding,headers:table.headers,calculationAudit,sourceCount:table.coverage.length,
  purpose:saved.receipt.purpose,note:'按已核验来源逐行重放匹配，范围及数据时点继承源文件，未刷新数据库。'};
}

export async function validateNewCsvArtifact(dataDir,job,item){
 const saved=await reportFile(dataDir,job.id,item,{includeReceipt:true});
 const proof=saved.receipt.csvArtifact;
 if(!proof?.sourceFiles?.length)fail('源码阶段的新增CSV必须通过来源配方校验');
 for(const source of proof.sourceFiles){
  const bound=boundSource(job,source.id);
  if(['sourceJobId','filename','sha256','verificationHash'].some(key=>bound[key]!==source[key]))fail('CSV来源文件已变化或超出原读取范围');
 }
 await inspectVerifiedCsvArtifact(dataDir,job,item,saved,{section:'summary'});
}
