import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';

export class ReportInputError extends Error {constructor(message){super(message);this.code='REPORT_INPUT';}}

// Dataset references live only inside one authorised transaction, never in model text or shared knowledge.
export class ReportDatasets {
 constructor({maxRows,previewRows=20,directory,authorize=async()=>{},active=()=>true,secrets=[]}){
  this.secrets=secrets.filter(Boolean);this.maxRows=maxRows;this.previewRows=Math.min(previewRows,20);this.directory=directory;this.authorize=authorize;this.active=active;this.datasets=new Map();this.bytes=0;this.files=0;
 }
 async check(){if(!this.active())throw new ReportInputError('报表查询已结束');await this.authorize();if(!this.active())throw new ReportInputError('报表查询已结束');}
 async collect(statement,execute){
  await this.check();if(this.datasets.size>=12)throw new ReportInputError('本轮完整数据集最多12份');
  const rows=[];const batch=500;let complete=false,bytes=0;
  for(let offset=0;offset<=this.maxRows;offset+=batch){
   await this.check();const size=Math.min(batch,this.maxRows-offset+1);
   const [page]=await execute({sql:`${statement.sql} LIMIT ${size} OFFSET ${offset}`},statement.params);
   await this.check();if(!Array.isArray(page)||page.length>size)throw new ReportInputError('报表分页返回异常');
   for(const row of page){
    if(rows.length===this.maxRows)break;
    const clean=Object.fromEntries(statement.columns.map(c=>{const v=row[c];if(v!==null&&!['string','number','bigint'].includes(typeof v))throw new ReportInputError('报表含不支持的字段值');if(typeof v==='number'&&!Number.isSafeInteger(v))throw new ReportInputError('报表数值未以精确字符串返回，停止导出');if(String(v??'').length>2000)throw new ReportInputError('报表字段过长');return [c,v===null?null:this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v))];}));
    bytes+=Buffer.byteLength(JSON.stringify(clean));if(bytes+this.bytes>16_000_000)throw new ReportInputError('完整数据集超过16MB限制；未生成文件');rows.push(clean);
   }
   if(page.length<size){complete=true;break;}
   if(page.length>this.maxRows-offset)break;
  }
  // A short final page proves completion; exactly-at-cap requires one look-ahead.
  const ref=`dataset-${randomUUID()}`;this.datasets.set(ref,{rows,columns:statement.columns,complete});this.bytes+=bytes;
  return {datasetRef:ref,rowCount:rows.length,complete,truncated:!complete,partial:!complete,columns:statement.columns,preview:preview(rows,this.previewRows),stage:complete?'分组数据已完整读取':'达到报表行数上限；数据不完整，不能合成完整报表'};
 }
 async compose(args){
  await this.check();if(this.files>=4)throw new ReportInputError('单次调查最多生成4个报表文件');if(!this.directory)throw new ReportInputError('本次执行未配置报表输出目录');
  if(!Array.isArray(args.sources)||!args.sources.length||args.sources.length>12||!Array.isArray(args.columns)||!args.columns.length||args.columns.length>12)throw new ReportInputError('报表需要1至12个来源及1至12列');
  const sources=new Map(),keys=new Set();
  for(const s of args.sources){
   if(!s||!/^s[0-9]{1,2}$/.test(s.name)||sources.has(s.name))throw new ReportInputError('来源name必须为不重复的s1、s2等');
   const data=this.datasets.get(s.datasetRef);if(!data?.complete||!data.columns.includes(s.keyColumn))throw new ReportInputError('来源必须为本轮完整数据集，并指定实际经销商主键列');
   const map=new Map();for(const row of data.rows){const key=row[s.keyColumn];if(key===null||key===''||map.has(key))throw new ReportInputError('来源主键为空或重复，不能直接拼接金额；请先按同一经销商粒度汇总');map.set(key,row);keys.add(key);}
   sources.set(s.name,{...data,map});
  }
  if(keys.size>this.maxRows)throw new ReportInputError('合并后超过报表行数上限；未生成文件');
  const headers=args.columns.map(c=>c?.label);if(headers.some(x=>typeof x!=='string'||!x.trim()||x.length>80)||new Set(headers).size!==headers.length)throw new ReportInputError('列标题应唯一且不超过80字符');
  let nodes=0;
  const validate=(e,depth=0)=>{if(++nodes>100||depth>6||!e||typeof e!=='object')throw new ReportInputError('报表列计算过于复杂');
   if(e.op==='key')return;
   if(e.op==='field'){const s=sources.get(e.source);if(!s?.columns.includes(e.column)||e.missing!==undefined&&!['zero','empty'].includes(e.missing))throw new ReportInputError('报表字段引用无效');return;}
   if(!['add','subtract','min'].includes(e.op)||!Array.isArray(e.args)||e.args.length<2||e.args.length>6)throw new ReportInputError('仅支持key、field、add、subtract、min固定计算，不接受表达式');e.args.forEach(x=>validate(x,depth+1));};
  args.columns.forEach(c=>validate(c.value));
  const evaluate=(e,key)=>{
   if(e.op==='key')return key;
   if(e.op==='field'){const row=sources.get(e.source).map.get(key);const v=row?.[e.column];if(v===undefined||v===null){if(e.missing==='zero')return '0';if(e.missing==='empty')return '';throw new ReportInputError('报表有缺失值；必须明确缺失值的业务处理规则');}return v;}
   const values=e.args.map(x=>decimal(evaluate(x,key)));let v=values[0];for(const n of values.slice(1))v=e.op==='add'?v+n:e.op==='subtract'?v-n:v<n?v:n;return format(v);
  };
  let outputBytes=0;const rows=[...keys].sort().map(key=>{const row=args.columns.map(c=>evaluate(c.value,key));outputBytes+=Buffer.byteLength(row.map(csvCell).join(','))+2;if(outputBytes>9_990_000)throw new ReportInputError('报表文件超过10MB，未生成文件');return row;});
  const csv='\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';const bytes=Buffer.byteLength(csv);if(bytes>10_000_000)throw new ReportInputError('报表文件超过10MB，未生成文件');
  const totals=Object.fromEntries(args.columns.flatMap((c,i)=>['add','subtract','min'].includes(c.value.op)||c.total===true?[[c.label,format(rows.reduce((n,row)=>n+decimal(row[i]),0n))]]:[]));
  const id=`report-${randomUUID()}`,filename=id+'.csv';await this.check();await mkdir(this.directory,{recursive:true,mode:0o700});
  const temp=path.join(this.directory,filename+'.tmp'),file=path.join(this.directory,filename);
  try{await writeFile(temp,csv,{mode:0o600,flag:'wx'});await this.check();await rename(temp,file);await this.check();}
  catch(error){await rm(temp,{force:true});await rm(file,{force:true});throw error;}
  this.files++;
  return {complete:true,truncated:false,rowCount:rows.length,columns:headers,totals,preview:preview(rows,this.previewRows),exportFile:{id,filename,bytes,sha256:createHash('sha256').update(csv).digest('hex'),rowCount:rows.length,complete:true},stage:'完整CSV报表已生成，可由Excel打开；完整读取不等于业务口径已验收'};
 }
 clear(){this.datasets.clear();this.bytes=0;}
}
const scale=10n**12n;
function decimal(value){const s=String(value);if(!/^-?\d{1,40}(?:\.\d{1,12})?$/.test(s))throw new ReportInputError('金额必须为最多12位小数的精确十进制值');const negative=s[0]==='-',parts=s.replace(/^-/,'').split('.');return (negative?-1n:1n)*(BigInt(parts[0])*scale+BigInt((parts[1]??'').padEnd(12,'0')));}
function format(n){const sign=n<0n?'-':'';if(n<0n)n=-n;const frac=String(n%scale).padStart(12,'0').replace(/0+$/,'');return sign+String(n/scale)+(frac?'.'+frac:'');}
function csvCell(v){let s=String(v??'');if(/^[\s\uFEFF]*[=+@-]/.test(s)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}

function preview(rows,limit){const out=[];let bytes=0;for(const row of rows.slice(0,limit)){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>8000)break;out.push(row);}return out;}
