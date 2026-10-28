import {compareExact} from './dataset-summary.js';
import {normalizeCalendarPeriod} from './calendar-period.js';
// Declarative task-local transformations; no SQL, eval, filesystem paths or business rules.
export function transformDataset(args, base) {
 const bad=m=>{throw Object.assign(new Error('数据集整理：'+m),{code:'REPORT_INPUT'});};
 if(!base?.complete||!Array.isArray(base.rows)||!base.columns.includes(args.keyColumn))bad('需要完整来源及实际唯一主键');
 if(typeof args.scopeEvidence!=='string'||args.scopeEvidence.trim().length<3)bad('必须说明范围依据');
 const column=c=>{if(!base.columns.includes(c))bad('字段不存在：'+c);};
 const compile=filters=>{
  if(!Array.isArray(filters))bad('filters必须为数组');
  return filters.map(f=>{
   column(f.column);if(!['eq','ne','in','not_in','is_null','is_not_null','gt','gte','lt','lte'].includes(f.op))bad('不支持的筛选操作');
   const scalar=v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isSafeInteger(v);
   if(['in','not_in'].includes(f.op)?!Array.isArray(f.values)||!f.values.every(scalar):!['is_null','is_not_null'].includes(f.op)&&!scalar(f.value))bad('筛选值必须为文本、安全整数或null');
   const norm=v=>v===null?null:String(v),values=f.values?.map(norm),value=norm(f.value);
   if(['gt','gte','lt','lte'].includes(f.op)){
    if(!['date','civil_day','civil_month','decimal','string'].includes(f.type)||f.nulls!==undefined&&!['error','exclude'].includes(f.nulls))bad('范围比较须明确date/civil_day/civil_month/decimal/string类型及空值规则');
    const date=x=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(x)||!Number.isFinite(Date.parse(x)))bad('日期比较必须为有效且含时区的ISO时间；不能猜测或把错误格式当范围外');const [y,m,d,h,min,sec]=x.slice(0,19).split(/[-T:]/).map(Number),v=new Date(Date.UTC(y,m-1,d,h,min,sec));if(v.getUTCFullYear()!==y||v.getUTCMonth()!==m-1||v.getUTCDate()!==d||h>23||min>59||sec>59)bad('日期比较包含无效日期');return Date.parse(x);};
    if(f.type==='civil_day'||f.type==='civil_month'){
     const unit=f.type==='civil_day'?'day':'month',boundary=normalizeCalendarPeriod(f.value,unit);
     return row=>{const x=row[f.column];if(x===null&&f.nulls==='exclude')return false;const civil=normalizeCalendarPeriod(x,unit),comparison=civil<boundary?-1:civil>boundary?1:0;return f.op==='gt'?comparison>0:f.op==='gte'?comparison>=0:f.op==='lt'?comparison<0:comparison<=0;};
    }
    if(f.type==='date')date(value);if(f.type==='decimal')compareExact(value,'0');
    return row=>{const x=row[f.column];if(x===undefined)bad('行缺少实际字段');if(x===null){if(f.nulls==='exclude')return false;bad('范围比较含真实空值，不能补零或静默排除');}const comparison=f.type==='date'?Math.sign(date(String(x))-date(value)):f.type==='decimal'?compareExact(String(x),value):Buffer.compare(Buffer.from(String(x)),Buffer.from(value));return f.op==='gt'?comparison>0:f.op==='gte'?comparison>=0:f.op==='lt'?comparison<0:comparison<=0;};
   }
   return row=>{const v=row[f.column];if(v===undefined)bad('行缺少实际字段');const x=norm(v);switch(f.op){case 'is_null':return x===null;case 'is_not_null':return x!==null;case 'eq':return x===value;case 'ne':return x!==value;case 'in':return values.includes(x);case 'not_in':return !values.includes(x);}};
  });
 };
 const filters=compile(args.filters??[]),index=new Map();
 for(const row of base.rows){const key=row[args.keyColumn];if(typeof key!=='string'||!key||index.has(key))bad('主键必须是非空唯一文本；不可静默去重');index.set(key,row);}
 let rows=base.rows.map(row=>({...row})),columns=[...base.columns],audit={inputCount:rows.length};
 if(args.hierarchy){
  const h=args.hierarchy;column(h.parentColumn);
  if(!Array.isArray(h.rootIds)||!h.rootIds.length||h.rootIds.some(x=>typeof x!=='string'||!index.has(x))||new Set(h.rootIds).size!==h.rootIds.length||typeof h.includeRoots!=='boolean')bad('根必须实际存在且唯一，明确includeRoots');
  const nodes=compile(h.nodeFilters??[]),eligible=row=>nodes.every(f=>f(row));
  if(h.rootIds.some(id=>!eligible(index.get(id))))bad('根未通过节点条件');
  const children=new Map(),done=new Set();let orphanCount=0;
  for(const [key,row] of index){const parent=row[h.parentColumn];if(parent!==null&&typeof parent!=='string')bad('父键必须为文本或null');if(parent&&index.has(parent)){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(key);}else if(parent)orphanCount++;
   const chain=new Set();let id=key;while(index.has(id)&&!done.has(id)){if(chain.has(id))bad('父子关系存在循环');chain.add(id);id=index.get(id)[h.parentColumn];}for(const id of chain)done.add(id);
  }
  const roots=new Set(h.rootIds),paths=new Map(),queue=h.rootIds.map(id=>[id,[id]]);let blockedNodeCount=0;
  for(let pos=0;pos<queue.length;pos++){const [id,chain]=queue[pos];if(paths.has(id))bad('多个根相互包含，路径语义不明确');paths.set(id,chain);for(const child of children.get(id)??[]){if(roots.has(child))bad('多个根相互包含');if(eligible(index.get(child)))queue.push([child,[...chain,child]]);else blockedNodeCount++;}}
  const fields=h.pathColumns??[];if(!Array.isArray(fields)||typeof h.separator!=='string'||!h.separator)bad('明确pathColumns和非空separator');
  for(const f of fields){column(f.column);if(typeof f.as!=='string'||!f.as||['__proto__','constructor','prototype'].includes(f.as)||columns.includes(f.as))bad('路径列重复或无效');columns.push(f.as);}
  rows=[];for(const [id,chain] of paths){if(!h.includeRoots&&roots.has(id))continue;const row={...index.get(id)};for(const f of fields){const values=chain.map(key=>index.get(key)[f.column]);if(values.some(x=>x===null||x===undefined))bad('路径分量为空，不能猜值');row[f.as]=values.join(h.separator);}rows.push(row);}
  audit={...audit,reachableCount:paths.size,blockedNodeCount,orphanCount,orphanPolicy:'仅记录来源中未解析父键；目标根以上不延伸，目标后代不跳过缺失节点'};
 }
 rows=rows.filter(row=>filters.every(f=>f(row)));
 const data={rows,columns,numericColumns:[...(base.numericColumns??[])],complete:true,readAt:base.readAt,readThroughAt:base.readThroughAt??base.readAt,snapshotId:base.snapshotId,derivation:{kind:'dataset_transform',version:'tree-filter-v1',args:structuredClone(args),audit:{...audit,outputCount:rows.length}}};
 return data;
}
