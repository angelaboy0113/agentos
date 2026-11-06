import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {normalizeCalendarPeriod} from './calendar-period.js';
import {reportCsv,encodeReportCsv} from './report-revision.js';
import {reportFile} from './report-files.js';
import {inspectReport} from './report-inspection.js';
import {TaskDatasetStore} from '../runner/task-dataset-store.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};
const hash=x=>createHash('sha256').update(x).digest('hex');
const keys=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
const name=x=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x)&&!['__proto__','prototype','constructor'].includes(x);

export function deliveredCsvDataset(attachment,bytes,args,job){
 const s=attachment?.source;
 if(s?.kind!=='delivered-report'||s.projectId!==job.projectId||s.originProfile!==job.originProfile||s.chatId!==job.chatId||hash(bytes)!==s.sha256)fail('原交付CSV不属于当前任务或摘要无效');
 if(!keys(args,['attachmentId','columns','rowKey'])||args.attachmentId!==attachment.id)fail('CSV导入仅接受登记输入和明确列索引');
 const data=reportCsv(bytes),fields=args.columns,key=args.rowKey??'input_row';
 if(data.rows.length!==s.report.rowCount||!name(key)||!Array.isArray(fields)||!fields.length||fields.some(f=>!keys(f,['index','as','type','normalization'])||!Number.isSafeInteger(f.index)||f.index<0||f.index>=data.headers.length||!name(f.as)||![undefined,'string'].includes(f.type)||![undefined,'none'].includes(f.normalization))||new Set([key,...fields.map(f=>f.as)]).size!==fields.length+1)fail('明确唯一输出列名和0-based索引；原CSV字符串不猜数字、空值或去重');
 return {columns:[key,...fields.map(f=>f.as)],rows:data.rows.map((r,i)=>Object.fromEntries([[key,String(i+1)],...fields.map(f=>[f.as,r[f.index]])])),numericColumns:[],complete:true,readAt:new Date().toISOString(),inputEvidence:{kind:'delivered-report',fileId:s.report.id,sourceJobId:s.sourceJobId,sha256:s.sha256,deliveredAt:s.deliveredAt,columns:fields,headers:data.headers,rowCount:data.rows.length,interpretation:'原CSV单元格输入；不是新数据库快照或独立金额基准'}};
}

export function formatReportValue(value,format){
 if(!keys(format,['kind','inputType'])||!['month_compact','day_compact'].includes(format.kind)||!['month','civil_day','civil_datetime'].includes(format.inputType))fail('格式转换须明确month_compact/day_compact及month/civil_day/civil_datetime；时间戳须先明确时区，不能猜测');
 if(format.inputType==='month'){if(format.kind==='day_compact')fail('仅有月份不能补造具体日期');return normalizeCalendarPeriod(value,'month').replace('-','');}
 if(typeof value!=='string')fail('民用日期必须是明确字符串，不能猜测数值时间戳');
 let day=value;
 if(format.inputType==='civil_datetime'){
  const m=value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/);
  if(!m||+m[2]>23||+m[3]>59||+m[4]>59)fail('民用日期时间无效或含时区歧义，不能截前六位掩盖错误');day=m[1];
 }
 const normalized=normalizeCalendarPeriod(day,'day');return format.kind==='day_compact'?normalized.replaceAll('-',''):normalized.slice(0,7).replace('-','');
}

export function appendReportColumns(input,supplement,args){
 if(!keys(args,['attachmentId','datasetRef','leftKey','rightKey','columns','missing','nulls','outside','requirement'])||typeof args.requirement!=='string'||!args.requirement.trim()||!input.headers.includes(args.leftKey)||!supplement.complete||!supplement.columns?.includes(args.rightKey)||!['error','empty'].includes(args.missing)||!['error','empty'].includes(args.nulls)||!['error','exclude'].includes(args.outside))fail('补列须明确原文件键、完整数据集键及未匹配/真实空值/范围外规则');
 const fields=args.columns;
 if(!Array.isArray(fields)||!fields.length||fields.some(f=>!keys(f,['column','label','format'])||!supplement.columns.includes(f.column)||typeof f.label!=='string'||!f.label.trim()||/^[\s\uFEFF]*[=+@-]/.test(f.label))||new Set([...input.headers,...fields.map(f=>f.label)]).size!==input.headers.length+fields.length)fail('新增列必须来自完整补充数据，表头非空且不能覆盖原列');
 if(fields.some(f=>!f.format&&supplement.numericColumns?.includes(f.column)))fail('新增数值/金额列应走既有独立计算与核验流程，不能用文件补列绕过');
 const index=input.headers.indexOf(args.leftKey),leftKeys=input.rows.map(row=>row[index]);
 if(leftKeys.some(k=>typeof k!=='string'||!k))fail('原文件关联键缺失，不能丢行或猜选');
 const allowed=new Set(leftKeys),mapped=new Map();let excluded=0,nullCells=0;
 for(const row of supplement.rows){
  const rawKey=row[args.rightKey],key=typeof rawKey==='string'?rawKey:Number.isSafeInteger(rawKey)?String(rawKey):null;
  if(!key||mapped.has(key))fail('补充来源关联键为空或重复，不能静默取第一条');
  // Validate all source values before applying the outside policy: bad dates cannot vanish as outside rows.
  const cells=fields.map(f=>{
   const value=row[f.column];if(value===null||value===undefined){nullCells++;if(args.nulls==='error')fail('补充字段存在真实空值');return '';}
   let text;if(f.format)text=formatReportValue(value,f.format);else if(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value))text=String(value);else fail('补充字段类型不明确或数值不精确');
   // Match normal report CSV protection without altering any original cell.
   return /^[\s\uFEFF]*[=+@-]/.test(text)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(text)?"'"+text:text;
  });
  mapped.set(key,cells);if(!allowed.has(key)){excluded++;if(args.outside==='error')fail('补充来源存在原文件范围外记录');}
 }
 let unmatched=0;const rows=input.rows.map(row=>{const cells=mapped.get(row[index]);if(!cells){unmatched++;if(args.missing==='error')fail('原文件存在未匹配记录，不能丢行或补零');}return [...row,...(cells??fields.map(()=>''))];});
 return {headers:[...input.headers,...fields.map(f=>f.label)],rows,audit:{originalRows:input.rows.length,outputRows:rows.length,originalColumns:input.headers.length,outputColumns:input.headers.length+fields.length,originalCellsPreserved:input.rows.length*input.headers.length,matchedRows:rows.length-unmatched,unmatchedRows:unmatched,nullSourceCells:nullCells,excludedSourceRows:excluded,duplicateLeftRows:leftKeys.length-allowed.size}};
}

export async function replayReportAppend(dataDir,revision,input){
 const b=revision.supplement;
 if(revision.kind!=='left_append'||!b||!/^[A-Za-z0-9_-]{1,100}$/.test(b.sourceJobId??'')||typeof b.scope!=='string')fail('文件补列来源绑定无效');
 const storage=new TaskDatasetStore(path.join(dataDir,'exports',b.sourceJobId),b.scope),saved=await storage.get(b.datasetRef);
 if(saved.dataHash!==b.dataHash||saved.readAt!==b.readAt)fail('补列完整数据集已改变或取数时间不一致');
 return appendReportColumns(input,saved.data,revision.recipe);
}

export async function appendReportFile(dataDir,job,attachment,args,saved){
 const s=attachment?.source;
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(job.id??'')||s?.kind!=='delivered-report'||s.projectId!==job.projectId||s.originProfile!==job.originProfile||s.chatId!==job.chatId||s.sourceEnvironment&&s.sourceEnvironment!==job.sourceEnvironment||args.attachmentId!==attachment.id||args.datasetRef!==saved.id)fail('原文件/补充数据与当前任务或环境不一致');
 const original={...s.report,sourceJobId:s.sourceJobId};await inspectReport(dataDir,{id:job.id,reportFiles:[original]},{fileId:original.id});
 const source=await reportFile(dataDir,s.sourceJobId,s.report),input=reportCsv(source.content),output=appendReportColumns(input,saved.data,args);
 if(input.rows.length!==s.report.rowCount)fail('原文件实际范围不一致');
 const previous=JSON.parse(await readFile(path.join(path.dirname(source.file),s.report.id+'.verification.json'),'utf8'));
 const revision={version:2,kind:'left_append',sourceJobId:s.sourceJobId,sourceFile:s.report,originalRowCount:input.rows.length,supplement:{sourceJobId:job.id,datasetRef:saved.id,scope:saved.scope,dataHash:saved.dataHash,readAt:saved.readAt},recipe:structuredClone(args),audit:output.audit};
 const id='report-'+randomUUID(),filename=id+'.csv',bytes=encodeReportCsv(output.headers,output.rows);
 const readTimes=[previous.readWindow?.earliest,previous.readWindow?.latest,saved.readAt].filter(Boolean).sort();
 const receipt={version:1,status:'verified',file:{id,sha256:hash(bytes)},coverage:{rowCount:output.rows.length},columnRules:output.headers.map(label=>({label,definition:'原文件保留；新增字段按固定关联与显式格式转换',evidence:s.report.id})),readWindow:{earliest:readTimes[0],latest:readTimes.at(-1),spreadMs:Date.parse(readTimes.at(-1))-Date.parse(readTimes[0]),maxSpreadMs:null},snapshotNote:'原文件与补充字段不同取数时间，不是同一事务；原有列未刷新',revision};
 const receiptBytes=Buffer.from(JSON.stringify(receipt)),directory=path.join(dataDir,'exports',job.id);await mkdir(directory,{recursive:true});
 if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==path.join(await realpath(path.join(dataDir,'exports')),job.id))fail('任务输出目录越界');
 await writeFile(path.join(directory,filename),bytes,{mode:0o600,flag:'wx'});await writeFile(path.join(directory,id+'.verification.json'),receiptBytes,{mode:0o600,flag:'wx'});
 const exportFile={id,filename,sha256:hash(bytes),bytes:bytes.length,rowCount:output.rows.length,verificationHash:hash(receiptBytes),complete:true};await reportFile(dataDir,job.id,exportFile,{includeContent:false});
 return {exportFile,headers:output.headers,readWindow:receipt.readWindow,revision,audit:output.audit,note:'原行序与原单元格保持，完整补充数据关联和日期格式已逐格核验；生成不等于投递，仍需正常交付审阅。'};
}
