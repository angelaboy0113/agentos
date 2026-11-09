import {createHash} from 'node:crypto';
const bad=m=>{throw Object.assign(new Error(m),{code:'REPORT_INPUT'});};
const scale=10n**12n;
function amount(v){if(typeof v!=='string'||!/^[-+]?\d+(?:\.\d{1,12})?$/.test(v))bad('数值必须为精确十进制文本，空值不可当零');const [a,b='']=v.replace(/^[-+]/,'').split('.');return (v.startsWith('-')?-1n:1n)*(BigInt(a)*scale+BigInt(b.padEnd(12,'0')));}
function format(n){const negative=n<0n;if(negative)n=-n;const f=String(n%scale).padStart(12,'0').replace(/0+$/,'');return (negative?'-':'')+String(n/scale)+(f?'.'+f:'');}
function ratio(a,b,{precision=2,zeroDenominator}={},factor,suffix){
 if(!Number.isInteger(precision)||precision<0||precision>12||!['empty','zero','error'].includes(zeroDenominator))bad('percentage须明确precision=0至12及zeroDenominator=empty/zero/error');
 const x=amount(String(a)),y=amount(String(b));if(!y){if(zeroDenominator==='error')bad('百分比分母为0');return zeroDenominator==='empty'?'':(0).toFixed(precision)+suffix;}
 const unit=10n**BigInt(precision),negative=(x<0n)!==(y<0n),num=(x<0n?-x:x)*BigInt(factor)*unit,den=y<0n?-y:y,n=(num+den/2n)/den;
 return (negative&&n?'-':'')+String(n/unit)+(precision?'.'+String(n%unit).padStart(precision,'0'):'')+suffix;
}
function collectText(a,items){
 const values=items.map(r=>r[a.column]);
 if(values.some(v=>v===undefined))bad('文本归并字段缺失，不能当作真实空值');
 if(values.some(v=>v!==null&&typeof v!=='string'))bad('collect_text仅支持文本；数值/日期类型须先明确转换，不得用作金额聚合');
 if(values.includes(null)&&a.nulls==='error')bad('文本归并存在真实空值，须明确保留或排除规则');
 let selected=a.nulls==='exclude'?values.filter(v=>v!==null):values;
 if(a.distinct)selected=[...new Set(selected)];
 if(a.order==='asc')selected.sort((x,y)=>x===y?0:x===null?-1:y===null?1:x<y?-1:1);
 return {value:!selected.length?null:a.format==='json'?JSON.stringify(selected):selected.join(a.separator),audit:{inputRows:items.length,nulls:values.filter(v=>v===null).length,emptyStrings:values.filter(v=>v==='').length,emittedValues:selected.length,duplicatesRemoved:a.distinct?(a.nulls==='exclude'?values.filter(v=>v!==null).length:values.length)-selected.length:0}};
}
export function summarizeDataset(args,base){
 if(!base?.complete||!Array.isArray(args.groupColumns)||args.groupColumns.some(c=>!base.columns.includes(c))||new Set(args.groupColumns).size!==args.groupColumns.length||!Array.isArray(args.aggregates)||!args.aggregates.length)bad('summarize_dataset需要完整来源、实际分组列和明确聚合');
 const rowKey=args.rowKey??'group_key',names=args.aggregates.map(a=>a.as),columns=[...args.groupColumns,...names,rowKey];
 if(columns.some(c=>typeof c!=='string'||!c||['__proto__','prototype','constructor'].includes(c))||new Set(columns).size!==columns.length)bad('汇总输出列重复或无效');
 for(const a of args.aggregates)if(!['count','count_distinct','sum','weighted_sum','collect_text'].includes(a.op)||(a.op!=='count'&&!base.columns.includes(a.column))||a.op==='weighted_sum'&&!base.columns.includes(a.weightColumn)||['sum','weighted_sum'].includes(a.op)&&!['error','empty','zero'].includes(a.nulls))bad('支持count/count_distinct/sum/weighted_sum/collect_text；金额须明确nulls，weighted_sum须指定实际weightColumn');
 for(const a of args.aggregates)if(a.op==='collect_text'&&(!['error','exclude','preserve'].includes(a.nulls)||typeof a.distinct!=='boolean'||!['source','asc'].includes(a.order)||!['json','join'].includes(a.format)||a.format==='join'&&(typeof a.separator!=='string'||!a.separator.length||a.nulls==='preserve')||base.numericColumns?.includes(a.column)))bad('collect_text须明确nulls=error/exclude/preserve、distinct布尔、order=source/asc、format=json/join；join须非空separator，保留null须json；不接受数值金额列');
 const textAudit=new Map();
 const groups=new Map();for(const row of base.rows){const key=JSON.stringify(args.groupColumns.map(c=>row[c]));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 if(!base.rows.length&&!args.groupColumns.length)groups.set('[]',[]);
 const rows=[];for(const [key,items] of groups){const row=Object.fromEntries(args.groupColumns.map((c,i)=>[c,JSON.parse(key)[i]]));
  for(const a of args.aggregates){if(a.op==='collect_text'){const collected=collectText(a,items);row[a.as]=collected.value;const audit=textAudit.get(a.as)??{column:a.as,groups:0,inputRows:0,nulls:0,emptyStrings:0,emittedValues:0,duplicatesRemoved:0,emptyGroups:0};audit.groups++;for(const k of ['inputRows','nulls','emptyStrings','emittedValues','duplicatesRemoved'])audit[k]+=collected.audit[k];if(collected.value===null)audit.emptyGroups++;textAudit.set(a.as,audit);}else if(a.op==='count')row[a.as]=String(items.length);else if(a.op==='count_distinct')row[a.as]=String(new Set(items.map(r=>r[a.column]).filter(v=>v!==null&&v!==undefined)).size);else{const values=items.map(r=>a.op==='weighted_sum'?[r[a.column],r[a.weightColumn]]:[r[a.column]]),missing=values.some(v=>v.some(x=>x===null||x===undefined));if(missing&&a.nulls==='error')bad('汇总金额或权重存在真实空值，不能补零');row[a.as]=missing&&a.nulls==='empty'?null:format(values.reduce((n,v)=>{if(v.some(x=>x===null||x===undefined))return n;let value=amount(v[0]);if(a.op==='weighted_sum'){const product=value*amount(v[1]);if(product%scale)bad('加权乘积超过已有12位精确小数范围，不能静默舍入');value=product/scale;}return n+value;},0n));}}
  row[rowKey]=createHash('sha256').update(key).digest('hex');rows.push(row);
 }
 return {rows,columns,numericColumns:args.aggregates.filter(a=>a.op!=='collect_text').map(a=>a.as),complete:true,readAt:base.readAt,readThroughAt:base.readThroughAt??base.readAt,snapshotId:base.snapshotId,derivation:{kind:'dataset_summary',version:args.aggregates.some(a=>a.op==='collect_text')?2:1,args:structuredClone(args),...(textAudit.size?{audit:{textColumns:[...textAudit.values()]}}:{})}};
}

export const percentage=(a,b,options={})=>ratio(a,b,options,100,'%');
export const divide=(a,b,options={})=>ratio(a,b,{precision:12,...options},1,'');

export const addExact=(a,b)=>format(amount(String(a))+amount(String(b)));
export const compareExact=(a,b)=>amount(String(a))<amount(String(b))?-1:amount(String(a))>amount(String(b))?1:0;
