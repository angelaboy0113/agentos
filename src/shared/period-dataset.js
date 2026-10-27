import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bad=m=>{throw Object.assign(new Error(m),{code:'REPORT_INPUT'});};
const scale=10n**12n;
const number=v=>{if(typeof v==='number'&&!Number.isSafeInteger(v))bad('金额数值须为安全整数或精确十进制字符串，不能使用浮点数');const s=String(v);if(!/^-?\d{1,40}(?:\.\d{1,12})?$/.test(s))bad('期间金额必须为精确十进制值，空值不能猜零');const [a,b='']=s.replace(/^-/,'').split('.');return (s[0]==='-'?-1n:1n)*(BigInt(a)*scale+BigInt(b.padEnd(12,'0')));};
const format=n=>{const sign=n<0n?'-':'';if(n<0n)n=-n;return sign+String(n/scale)+(n%scale?'.'+String(n%scale).padStart(12,'0').replace(/0+$/,''):'');};
const field=x=>typeof x==='string'&&x.trim()&&!['__proto__','constructor','prototype'].includes(x);
function keys(data,columns){if(!Array.isArray(columns)||!columns.length||new Set(columns).size!==columns.length||columns.some(c=>!data.columns.includes(c)))bad('期间数据需要真实且不重复的关联键列');}
function key(row,columns){const values=columns.map(c=>row[c]);if(values.some(v=>typeof v!=='string'||!v))bad('期间数据关联键为空或类型错误');return JSON.stringify(values);}
export function periodValues(period){
 if(!period||!field(period.column))bad('必须指定期间输出列');
 if(period.unit==='values'){if(!Array.isArray(period.values)||!period.values.length||period.values.some(v=>typeof v!=='string'||!v)||new Set(period.values).size!==period.values.length)bad('自定义期间值须为有序、不重复的字符串');return [...period.values];}
 const month=period.unit==='month',day=period.unit==='day';if(!month&&!day)bad('期间单位仅支持month、day或values');
 const parse=v=>{if(typeof v!=='string'||!(month?/^\d{4}-\d{2}$/:/^\d{4}-\d{2}-\d{2}$/).test(v))bad('期间必须为标准YYYY-MM或YYYY-MM-DD');const d=new Date(v+(month?'-01':'')+'T00:00:00Z');if(!Number.isFinite(+d)||d.getUTCFullYear()<1||d.toISOString().slice(0,month?7:10)!==v)bad('期间日期不存在');return d;};
 const start=parse(period.start),end=parse(period.end);if(start>end)bad('期间起点晚于终点');const values=[];
 for(let d=new Date(start);d<=end;month?d.setUTCMonth(d.getUTCMonth()+1):d.setUTCDate(d.getUTCDate()+1))values.push(d.toISOString().slice(0,month?7:10));return values;
}
export function normalizeCalendarPeriod(value,unit){
 const text=typeof value==='string'?value.trim():Number.isSafeInteger(value)?String(value):'';
 if(!['month','day'].includes(unit))bad('日历规范化必须明确month或day粒度');
 const match=unit==='month'?text.match(/^(\d{4})(\d{2})$/)??text.match(/^(\d{4})-(\d{1,2})$/):text.match(/^(\d{4})(\d{2})(\d{2})$/)??text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(!match||Number(match[1])<1)bad('来源期间格式无效：月支持YYYYMM、YYYY-MM、YYYY-M；日支持YYYYMMDD或YYYY-MM-DD；不能当作无发生额补零');
 const canonical=match.slice(1).map(v=>v.padStart(2,'0')).join('-');
 const date=new Date(canonical+(unit==='month'?'-01':'')+'T00:00:00Z');
 if(!Number.isFinite(+date)||date.toISOString().slice(0,unit==='month'?7:10)!==canonical)bad('来源期间日期不存在，不能按范围外排除或补零');
 return canonical;
}
function sourcePeriod(row,source,period,normalization){
 let value=row[source.periodColumn];
 if(period.unit==='values'&&(typeof value!=='string'||!value))bad('自定义期间来源必须为显式非空字符串，不猜测空值或数值语义');
 if(source.yearColumn){if(period.unit!=='month'||!/^\d{4}$/.test(row[source.yearColumn])||!/^\d{1,2}$/.test(value))bad('yearColumn模式需要四位年和1至12月');const m=Number(value);if(m<1||m>12)bad('来源月份超出1至12');value=row[source.yearColumn]+'-'+String(m).padStart(2,'0');}
 return ['calendar-v1','calendar-v2'].includes(normalization)&&period.unit!=='values'?normalizeCalendarPeriod(value,period.unit):value;
}
// Pure, repeatable transformation: no SQL, paths, eval or arbitrary code.
export async function buildPeriodDataset(args,load,{check=async()=>{},maxRows=Number.MAX_SAFE_INTEGER,legacy=false}={}){
 const normalization=legacy?null:(args.periodNormalization??'calendar-v2');
 if(args.periodNormalization&&!['calendar-v1','calendar-v2'].includes(args.periodNormalization))bad('未知期间转换版本');
 const effectiveArgs=legacy?structuredClone(args):{...structuredClone(args),periodNormalization:normalization};
 const population=await load(args.populationRef);if(!population?.complete||population.reportDraft)bad('期间全集须为完整的原始或维度数据集');keys(population,args.keyColumns);
 const periods=periodValues(args.period),periodSet=new Set(periods),rowKey=args.rowKey??'period_key';
 const columns=[...population.columns,args.period.column,rowKey];if(!field(rowKey)||new Set(columns).size!==columns.length)bad('期间或组合键输出列与原字段重复');
 if(!Array.isArray(args.sources))bad('sources必须为数组；仅生成完整期间范围时传空数组');
 const populationMap=new Map();for(const row of population.rows){const k=key(row,args.keyColumns);if(populationMap.has(k))bad('主对象关联键重复，先核对粒度，不能静默去重');populationMap.set(k,row);}
 if(!Number.isSafeInteger(population.rows.length*periods.length)||population.rows.length*periods.length>maxRows)bad('期间展开超过已配置的报表行数范围');
 const inputs=[population],numericColumns=[...(population.numericColumns??[])],indexes=[],audits=[],provenance={};
 for(const s of args.sources){
  await check();const d=await load(s.datasetRef);if(!d?.complete||d.reportDraft)bad('金额来源必须是完整数据集');keys(d,s.keyColumns);if(s.keyColumns.length!==args.keyColumns.length||!d.columns.includes(s.periodColumn)||s.yearColumn&&!d.columns.includes(s.yearColumn))bad('期间来源关联列不匹配');
  if(!['error','sum'].includes(s.duplicates)||!['error','exclude'].includes(s.outside)||!Array.isArray(s.metrics)||!s.metrics.length)bad('明确duplicates=error/sum、outside=error/exclude及金额列');
  if(s.outside==='exclude'&&!(typeof s.outsideEvidence==='string'&&s.outsideEvidence.trim().length>=3))bad('排除全集外记录必须说明依据');
  const index=new Map(),audit={datasetRef:s.datasetRef,inputRows:d.rows.length,matchedRows:0,...(normalization==='calendar-v2'?{outsidePopulationRows:0,outsidePeriodRows:0}:{}),outsideRows:0,duplicateRows:0,missingCells:0,nullCells:0,outsideEvidence:s.outsideEvidence??null};
  for(const m of s.metrics){if(!d.columns.includes(m.column)||!field(m.as)||!['zero','empty','error'].includes(m.missing)||!['zero','empty','error'].includes(m.nulls))bad('金额列须指定真实字段及missing/nulls处理规则');for(const c of [m.as,m.cumulativeAs,m.statusAs].filter(x=>x!==undefined)){if(!field(c)||columns.includes(c))bad('金额输出列重复');columns.push(c);if(c!==m.statusAs)numericColumns.push(c);provenance[c]={datasetRef:s.datasetRef,column:m.column,cumulative:c===m.cumulativeAs};}}
  for(const row of d.rows){const k=key(row,s.keyColumns),period=sourcePeriod(row,s,args.period,normalization);if(!populationMap.has(k)||!periodSet.has(period)){audit.outsideRows++;if(Object.hasOwn(audit,'outsidePopulationRows')){if(!populationMap.has(k))audit.outsidePopulationRows++;if(!periodSet.has(period))audit.outsidePeriodRows++;}if(s.outside==='error')bad('来源包含全集或期间范围外记录；核对范围或明确exclude及依据');continue;}audit.matchedRows++;const cellKey=JSON.stringify([k,period]);let amounts=index.get(cellKey);if(amounts){audit.duplicateRows++;if(s.duplicates==='error')bad('同一对象同一期间存在重复金额记录；先核对粒度或明确sum');}else {amounts=s.metrics.map(()=>0n);index.set(cellKey,amounts);}
   s.metrics.forEach((m,i)=>{const v=row[m.column];if(v===null||v===''){audit.nullCells++;if(m.nulls==='error')bad('实际金额为空；必须明确nulls规则');if(m.nulls==='empty')amounts[i]=null;}else {const amount=number(v);if(amounts[i]!==null)amounts[i]+=amount;}});
  }
  inputs.push(d);indexes.push({s,index,audit});audits.push(audit);
 }
 const rows=[];
 for(const [k,base] of [...populationMap].sort(([a],[b])=>a.localeCompare(b))){const running=indexes.map(({s})=>s.metrics.map(()=>0n));
  for(const period of periods){if(rows.length%500===0)await check();const row={...base,[args.period.column]:period,[rowKey]:hash([...JSON.parse(k),period])};
   indexes.forEach(({s,index,audit},j)=>{const values=index.get(JSON.stringify([k,period]));s.metrics.forEach((m,i)=>{let v=values?.[i];if(m.statusAs)row[m.statusAs]=v===undefined?'no_occurrence':v===null?'unknown':'known';if(v===undefined){audit.missingCells++;if(m.missing==='error')bad('缺少对象期间金额记录；必须明确missing规则');v=m.missing==='zero'?0n:null;}row[m.as]=v===null?null:format(v);if(m.cumulativeAs){running[j][i]=running[j][i]===null||v===null?null:running[j][i]+v;row[m.cumulativeAs]=running[j][i]===null?null:format(running[j][i]);}});});rows.push(row);
  }
 }
 return {rows,columns,numericColumns,complete:true,readAt:inputs.map(d=>d.readAt).sort()[0],readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),snapshotId:inputs.every(d=>d.snapshotId===inputs[0].snapshotId)?inputs[0].snapshotId:hash(inputs.map(d=>d.snapshotId).sort()),derivation:{kind:'period_grid',args:effectiveArgs,audit:{objects:populationMap.size,periods:periods.length,rowCount:rows.length,sources:audits},provenance}};
}
export async function verifyPeriodDataset(data,load,options={}){
 const kind=data?.derivation?.kind;if(!['left_lookup','period_grid'].includes(kind))return;
 const state=options.state??(options.state={visiting:new Set(),done:new Set()}),token=options.ref??data;
 if(state.visiting.has(token))bad('期间数据依赖循环');if(state.done.has(token))return;
 state.visiting.add(token);
 try{
  const dependencies=new Map(),read=async ref=>{if(dependencies.has(ref))return dependencies.get(ref);const d=await load(ref);if(!d?.complete)bad('期间依赖缺失或不完整');await verifyPeriodDataset(d,load,{...options,state,ref});dependencies.set(ref,d);return d;};
  if(kind==='left_lookup'){await read(data.derivation.datasetRef);for(const l of data.derivation.lookups)await read(l.datasetRef);}
  else {
   const args=data.derivation.args;
   for(const ref of [args.populationRef,...args.sources.map(s=>s.datasetRef)])await read(ref);
   if(!args.periodNormalization&&args.period.unit!=='values'){
    for(const source of args.sources)for(const row of dependencies.get(source.datasetRef).rows)if(sourcePeriod(row,source,args.period,null)!==sourcePeriod(row,source,args.period,'calendar-v2'))bad('历史期间配方存在未统一月份；请用原始来源重新period_dataset并核验，不能沿用旧补零结果');
   }
   const rebuilt=await buildPeriodDataset(args,ref=>dependencies.get(ref),{...options,legacy:!args.periodNormalization});
   for(const key of ['rows','columns','numericColumns','readAt','readThroughAt','snapshotId','derivation'])if(JSON.stringify(data[key])!==JSON.stringify(rebuilt[key]))bad('期间派生数据与原来源重算不一致，不能核验或交付');
  }
  state.done.add(token);
 }finally{state.visiting.delete(token);}
}
