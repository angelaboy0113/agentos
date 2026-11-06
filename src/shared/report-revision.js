import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {reportFile} from './report-files.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,allowed)=>plain(x)&&Object.keys(x).every(k=>allowed.includes(k));
// Strict RFC4180 cells, including embedded newlines, BOM, duplicates and empty strings.
export function reportCsv(bytes){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''),rows=[];
 let row=[],value='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
  if(c==='"'){if(value||closed)fail('CSV引号位置无效');quoted=true;continue;}
  if(c===','||c==='\r'||c==='\n'){
   row.push(value);value='';closed=false;
   if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;rows.push(row);row=[];}continue;
  }
  if(closed)fail('CSV结束引号后存在额外字符');value+=c;
 }
 if(quoted)fail('CSV引号未结束');if(row.length||value||closed){row.push(value);rows.push(row);}
 if(!rows.length||!rows[0].length||rows[0].some(c=>!c.trim())||new Set(rows[0]).size!==rows[0].length||rows.some(r=>r.length!==rows[0].length))fail('CSV表头或实际列数不一致');
 return {headers:rows[0],rows:rows.slice(1)};
}
const cell=v=>'"'+String(v).replaceAll('"','""')+'"';
export const encodeReportCsv=(headers,rows)=>Buffer.from('\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n');
const encode=encodeReportCsv;
export function projectReport(input,args){
 if(!keys(args,['attachmentId','columns','filters','orderBy','requirement'])||typeof args.requirement!=='string'||!args.requirement.trim())fail('明确本次文件修改要求，不能执行任意代码或修改单元格数值');
 const columns=args.columns??input.headers.map(from=>({from,label:from}));
 if(!Array.isArray(columns)||!columns.length||columns.some(c=>!keys(c,['from','label'])||!input.headers.includes(c.from)||typeof c.label!=='string'||!c.label.trim()||/^[\s\uFEFF]*[=+@-]/.test(c.label))||new Set(columns.map(c=>c.label)).size!==columns.length)fail('列必须来自原文件，输出表头唯一且非空');
 const filters=args.filters??[],order=args.orderBy??[];
 if(!Array.isArray(filters)||filters.some(f=>!keys(f,['column','op','value'])||!input.headers.includes(f.column)||!['eq','ne'].includes(f.op)||typeof f.value!=='string'))fail('筛选只接受实际列和明确的字符串eq/ne，不猜测日期或数字');
 if(!Array.isArray(order)||order.some(o=>!keys(o,['column','direction'])||!input.headers.includes(o.column)||!['asc','desc'].includes(o.direction)))fail('排序只接受实际列和asc/desc，按原字符串排序');
 const index=new Map(input.headers.map((c,i)=>[c,i]));
 const selected=input.rows.filter(r=>filters.every(f=>f.op==='eq'?r[index.get(f.column)]===f.value:r[index.get(f.column)]!==f.value));
 selected.sort((a,b)=>{for(const o of order){const x=a[index.get(o.column)],y=b[index.get(o.column)];if(x!==y)return(x<y?-1:1)*(o.direction==='asc'?1:-1);}return 0;});
 return {headers:columns.map(c=>c.label),rows:selected.map(r=>columns.map(c=>r[index.get(c.from)])),recipe:{columns,filters,orderBy:order,requirement:args.requirement}};
}

export async function reviseReportFile(dataDir,job,attachment,args){
 const s=attachment?.source;
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(job.id??''))fail('任务输出标识无效');
 if(s?.kind!=='delivered-report'||attachment.id!==args.attachmentId||s.projectId!==job.projectId||s.chatId!==job.chatId||s.originProfile!==job.originProfile)fail('文件不属于当前任务身份/项目/群');
 if(s.sourceEnvironment&&s.sourceEnvironment!==job.sourceEnvironment)fail('原文件环境与当前任务不同；保留原环境接续文件修改，不能改标签冒充其它环境数据');
 // Recompute the original evidence, including any preceding file revision.
 const {inspectReport}=await import('./report-inspection.js');
 await inspectReport(dataDir,{id:job.id,reportFiles:[{...s.report,sourceJobId:s.sourceJobId}]},{fileId:s.report.id});
 const source=await reportFile(dataDir,s.sourceJobId,s.report),input=reportCsv(source.content),output=projectReport(input,args);
 if(input.rows.length!==s.report.rowCount)fail('原文件实际行数与登记不一致');
 const id='report-'+randomUUID(),filename=id+'.csv',bytes=encode(output.headers,output.rows);
 const originalReceipt=JSON.parse(await readFile(path.join(path.dirname(source.file),s.report.id+'.verification.json'),'utf8'));
 const receipt={version:1,status:'verified',file:{id,sha256:hash(bytes)},coverage:{rowCount:output.rows.length},
  columnRules:output.headers.map(label=>({label,definition:'原文件单元格投影；没有新增计算',evidence:s.report.id})),
  readWindow:originalReceipt.readWindow??null,
  revision:{version:1,sourceJobId:s.sourceJobId,sourceFile:s.report,recipe:output.recipe,originalRowCount:input.rows.length,
   rule:'文件重排/筛选/选列，数值逐格来自原始已核验CSV；不证明最新业务数据或新的金额口径。'}};
 const receiptBytes=Buffer.from(JSON.stringify(receipt)),directory=path.join(dataDir,'exports',job.id);
 await mkdir(directory,{recursive:true});
 // The trusted task output boundary is checked by the shared file registrar before exposure.
 const {lstat,realpath}=await import('node:fs/promises');
 if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==path.join(await realpath(path.join(dataDir,'exports')),job.id))fail('文件输出任务目录越界');
 await writeFile(path.join(directory,filename),bytes,{mode:0o600,flag:'wx'});
 await writeFile(path.join(directory,id+'.verification.json'),receiptBytes,{mode:0o600,flag:'wx'});
 const exportFile={id,filename,sha256:hash(bytes),bytes:bytes.length,rowCount:output.rows.length,verificationHash:hash(receiptBytes),complete:true};
 await reportFile(dataDir,job.id,exportFile,{includeContent:false});
 const changed=!bytes.equals(source.content);
 return {exportFile,changed,headers:output.headers,readWindow:receipt.readWindow,revision:receipt.revision,
  note:changed?'新版本已生成且与原文件按配方逐格核对，原文件保持不变；等待正常交付审阅和投递，不是新数据库查询。':'配方没有改变原文件内容，不能作为新增字段或其它实质修改已完成的证明；新增字段请使用import_task_input及append_report_columns。'};
}

export async function inspectRevision(dataDir,job,item,receipt,args,visited=new Set()){
 const r=receipt.revision,key=(item.sourceJobId??job.id)+':'+item.id;
 if(visited.has(key)||![1,2].includes(r?.version))fail('文件修订来源循环或版本无效');visited.add(key);
 const source=await reportFile(dataDir,r.sourceJobId,r.sourceFile),sourceReceipt=JSON.parse(await readFile(path.join(path.dirname(source.file),r.sourceFile.id+'.verification.json'),'utf8'));
 if(sourceReceipt.revision)await inspectRevision(dataDir,{id:r.sourceJobId},r.sourceFile,sourceReceipt,{section:'summary'},visited);
 else {const {inspectReport}=await import('./report-inspection.js');await inspectReport(dataDir,{id:r.sourceJobId,reportFiles:[{...r.sourceFile,sourceJobId:r.sourceJobId}]},{fileId:r.sourceFile.id});}
 const input=reportCsv(source.content),output=r.version===2?await (await import('./report-append.js')).replayReportAppend(dataDir,r,input):projectReport(input,r.recipe),verified=await reportFile(dataDir,item.sourceJobId??job.id,item);
 if(!encode(output.headers,output.rows).equals(verified.content)||output.rows.length!==item.rowCount)fail('文件修订内容与原文件/保存配方不一致');
 const binding={fileId:item.id,sourceJobId:item.sourceJobId??job.id,sha256:item.sha256,verificationHash:item.verificationHash,rowCount:item.rowCount};
 const audit={status:'passed',checkedRows:output.rows.length,checkedCells:output.rows.length*output.headers.length};
 const section=args.section??'summary';
 if(section==='rows'){
  const headers=args.columns??output.headers;
  if(!headers.length||new Set(headers).size!==headers.length||headers.some(h=>!output.headers.includes(h)))fail('请选择实际修订文件表头');
  const offset=args.offset??0,limit=args.limit??4,items=[];let size=0;
  for(let i=offset;i<Math.min(output.rows.length,offset+limit);i++){const entry={rowNumber:i+1,values:headers.map(h=>output.rows[i][output.headers.indexOf(h)])};const n=Buffer.byteLength(JSON.stringify(entry));if(items.length&&size+n>16000)break;items.push(entry);size+=n;}
  return {binding,section,headers,items,totalCount:output.rows.length,nextOffset:offset+items.length<output.rows.length?offset+items.length:null,calculationAudit:audit};
 }
 const all=section==='columns'?receipt.columnRules:section==='sources'?[r]:section==='scope'?[{originalRowCount:r.originalRowCount,rowCount:item.rowCount,filters:r.recipe.filters}]:[];
 if(section!=='summary'){const offset=args.offset??0,limit=args.limit??4;return {binding,section,items:all.slice(offset,offset+limit),totalCount:all.length,nextOffset:offset+limit<all.length?offset+limit:null,calculationAudit:audit};}
 return {status:'verified',binding,headers:output.headers,preview:output.rows.slice(0,3),revision:r,readWindow:receipt.readWindow,calculationAudit:audit,note:'原文件派生版本；单元格逐格复算通过，无新查询或金额公式变化。逐行用section=rows分页读取。'};
}
