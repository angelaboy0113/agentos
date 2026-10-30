import {createHash} from 'node:crypto';
import {normalizeCalendarPeriod} from './calendar-period.js';
import {percentage} from './dataset-summary.js';
const bad=m=>{throw Object.assign(new Error('窗口统计：'+m),{code:'REPORT_INPUT'});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const field=x=>typeof x==='string'&&x.trim()&&!['__proto__','prototype','constructor'].includes(x);
function instant(x){
 if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(x)||!Number.isFinite(Date.parse(x)))bad('instant必须为有效且含明确时区的ISO时间；民用日请显式选择civil_day，不猜测时区');
 const [y,m,d,h,mi,s]=x.slice(0,19).split(/[-T:]/).map(Number),dt=new Date(Date.UTC(y,m-1,d));
 if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d||h>23||mi>59||s>59)bad('无效时间');return Date.parse(x);
}
const time=(x,type)=>type==='instant'?instant(x):normalizeCalendarPeriod(x,type==='civil_day'?'day':'month');
function key(row,columns){return JSON.stringify(columns.map(c=>{const v=row[c];if(typeof v==='string'&&v)return v;if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);bad('对象/分组关联键必须为非空文本或安全整数；不能猜测空键');}));}
function columns(data,keys){if(!Array.isArray(keys)||!keys.length||new Set(keys).size!==keys.length||keys.some(c=>!data.columns.includes(c)))bad('需要实际且不重复的键列');}
// Pure complete-population/window operation. Explicit boundaries, no relative
// business dates, implicit timezone, guessed join, SQL or external execution.
export async function buildWindowDataset(args,load,{check=async()=>{}}={}){
 const p=await load(args.populationRef);if(!p?.complete||p.reportDraft)bad('需要完整主对象来源，不能以报表草稿作分母');
 columns(p,args.populationKeys);columns(p,args.groupColumns);
 if(!['instant','civil_day','civil_month'].includes(args.timeType))bad('timeType须明确instant/civil_day/civil_month');
 if(!Array.isArray(args.windows)||!args.windows.length)bad('需要显式窗口列表');
 const denominator=args.denominatorColumn??'population_count',rowKey=args.rowKey??'group_key';
 const names=[...args.groupColumns,denominator,rowKey,...args.windows.flatMap(w=>[w.countColumn,...(w.percentageColumn?[w.percentageColumn]:[])])];
 if(names.some(n=>!field(n))||new Set(names).size!==names.length)bad('输出列必须非空且不重复');
 const windows=args.windows.map(w=>{const start=time(w.start,args.timeType),end=time(w.end,args.timeType);if(start>=end)bad('窗口须为有效左闭右开范围start<end');if(w.percentageColumn)percentage('0','1',{precision:w.precision??2,zeroDenominator:w.zeroDenominator??'empty'});return {...w,start,end};});
 if(!Array.isArray(args.sources)||!args.sources.length)bad('sources需要完整事件来源，空来源不能假装无发生额');
 if(args.populationDuplicates!==undefined&&!['error','deduplicate'].includes(args.populationDuplicates))bad('populationDuplicates仅支持error/deduplicate');
 if(args.populationDuplicates==='deduplicate'&&!(typeof args.duplicateEvidence==='string'&&args.duplicateEvidence.trim().length>=3))bad('主对象去重须说明依据');
 const population=new Map(),groups=new Map();let duplicates=0;
 for(const row of p.rows){const k=key(row,args.populationKeys),g=key(row,args.groupColumns);if(population.has(k)){if(population.get(k)!==g||args.populationDuplicates!=='deduplicate')bad('主对象键重复或归属冲突；按实际粒度明确去重依据');duplicates++;continue;}population.set(k,g);if(!groups.has(g))groups.set(g,{base:Object.fromEntries(args.groupColumns.map(c=>[c,row[c]])),population:new Set(),hits:windows.map(()=>new Set())});groups.get(g).population.add(k);}
 const inputs=[p],audits=[];
 for(const source of args.sources){
  await check();const d=await load(source.datasetRef);if(!d?.complete||d.reportDraft)bad('事件来源必须完整，不能用样本/草稿');
  columns(d,source.populationKeys);if(source.populationKeys.length!==args.populationKeys.length||!d.columns.includes(source.timeColumn))bad('事件关联键数量或时间列不匹配');
  if(source.outsidePopulation!==undefined&&!['error','exclude'].includes(source.outsidePopulation))bad('outsidePopulation仅支持error/exclude');
  if(source.outsidePopulation==='exclude'&&!(typeof source.outsideEvidence==='string'&&source.outsideEvidence.trim().length>=3))bad('排除主范围外事件须说明依据');
  const audit={datasetRef:source.datasetRef,inputRows:d.rows.length,outsidePopulationRows:0,outsideWindowRows:0};
  for(let i=0;i<d.rows.length;i++){
   if(i%500===0)await check();const row=d.rows[i];let value;try{value=time(row[source.timeColumn],args.timeType);}catch(error){bad('来源时间格式错误，列'+source.timeColumn+'，行'+(i+1)+'；'+error.message);}
   const k=key(row,source.populationKeys),g=population.get(k);
   if(g===undefined){audit.outsidePopulationRows++;if(source.outsidePopulation!=='exclude')bad('事件包含主对象范围外记录，需核对范围或显式exclude及依据');continue;}
   let matched=false;windows.forEach((w,n)=>{if(value>=w.start&&value<w.end){groups.get(g).hits[n].add(k);matched=true;}});if(!matched)audit.outsideWindowRows++;
  }
  inputs.push(d);audits.push(audit);
 }
 const rows=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([g,v])=>{const row={...v.base,[denominator]:String(v.population.size),[rowKey]:createHash('sha256').update(g).digest('hex')};windows.forEach((w,i)=>{row[w.countColumn]=String(v.hits[i].size);if(w.percentageColumn)row[w.percentageColumn]=percentage(row[w.countColumn],row[denominator],{precision:w.precision??2,zeroDenominator:w.zeroDenominator??'empty'});});return row;});
 return {rows,columns:names,numericColumns:[denominator,...windows.map(w=>w.countColumn)],complete:true,readAt:inputs.map(d=>d.readAt).sort()[0],readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),snapshotId:hash(inputs.map(d=>d.snapshotId)),derivation:{kind:'window_counts',version:1,args:structuredClone(args),audit:{populationRows:p.rows.length,uniqueObjects:population.size,populationDuplicates:duplicates,groups:groups.size,sources:audits},semantics:'Explicit [start,end) windows; each population identity counts once per group/window across all sources. Current complete population is the denominator. Not one transaction snapshot.'}};
}
