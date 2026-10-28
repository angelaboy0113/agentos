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
export function summarizeDataset(args,base){
 if(!base?.complete||!Array.isArray(args.groupColumns)||args.groupColumns.some(c=>!base.columns.includes(c))||new Set(args.groupColumns).size!==args.groupColumns.length||!Array.isArray(args.aggregates)||!args.aggregates.length)bad('summarize_dataset需要完整来源、实际分组列和明确聚合');
 const rowKey=args.rowKey??'group_key',names=args.aggregates.map(a=>a.as),columns=[...args.groupColumns,...names,rowKey];
 if(columns.some(c=>typeof c!=='string'||!c||['__proto__','prototype','constructor'].includes(c))||new Set(columns).size!==columns.length)bad('汇总输出列重复或无效');
 for(const a of args.aggregates)if(!['count','count_distinct','sum'].includes(a.op)||(a.op!=='count'&&!base.columns.includes(a.column))||a.op==='sum'&&!['error','empty','zero'].includes(a.nulls))bad('只支持count/count_distinct/sum，sum须明确nulls');
 const groups=new Map();for(const row of base.rows){const key=JSON.stringify(args.groupColumns.map(c=>row[c]));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 if(!base.rows.length&&!args.groupColumns.length)groups.set('[]',[]);
 const rows=[];for(const [key,items] of groups){const row=Object.fromEntries(args.groupColumns.map((c,i)=>[c,JSON.parse(key)[i]]));
  for(const a of args.aggregates){if(a.op==='count')row[a.as]=String(items.length);else if(a.op==='count_distinct')row[a.as]=String(new Set(items.map(r=>r[a.column]).filter(v=>v!==null&&v!==undefined)).size);else{const values=items.map(r=>r[a.column]);if(values.some(v=>v===null||v===undefined)&&a.nulls==='error')bad('汇总金额存在真实空值，不能补零');row[a.as]=values.some(v=>v===null||v===undefined)&&a.nulls==='empty'?null:format(values.reduce((n,v)=>n+(v===null||v===undefined?0n:amount(v)),0n));}}
  row[rowKey]=createHash('sha256').update(key).digest('hex');rows.push(row);
 }
 return {rows,columns,numericColumns:names,complete:true,readAt:base.readAt,readThroughAt:base.readThroughAt??base.readAt,snapshotId:base.snapshotId,derivation:{kind:'dataset_summary',version:1,args:structuredClone(args)}};
}

export const percentage=(a,b,options={})=>ratio(a,b,options,100,'%');
export const divide=(a,b,options={})=>ratio(a,b,{precision:12,...options},1,'');

export const addExact=(a,b)=>format(amount(String(a))+amount(String(b)));
export const compareExact=(a,b)=>amount(String(a))<amount(String(b))?-1:amount(String(a))>amount(String(b))?1:0;
