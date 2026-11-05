import {parseExactJson} from './exact-json.js';
import {datasetHash} from './dataset-json.js';
import {compareExact} from './dataset-summary.js';
import {normalizeCalendarPeriod} from './calendar-period.js';
// Explicit identifier conversion preserves textual leading zeros and nulls.
export function exactText(value,normalization='none'){
 const bad=()=>{throw Object.assign(new Error('文本转换需要原始文本、安全整数或布尔值；整数十进制规范化不接受小数、科学计数法或不安全数字'),{code:'REPORT_INPUT'});};
 if(!['none','integer_decimal'].includes(normalization))bad();
 if(value===null)return null;
 if(typeof value==='string'){if(normalization==='integer_decimal'&&!/^[+-]?\d+$/.test(value))bad();return normalization==='integer_decimal'?BigInt(value).toString():value;}
 if(typeof value==='number'){if(!Number.isSafeInteger(value))bad();return String(value);}
 if(typeof value==='boolean'&&normalization==='none')return String(value);
 bad();
}
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
 if(Object.keys(args).some(k=>!['datasetRef','keyColumn','scopeEvidence','filters','hierarchy','conversions','json'].includes(k)))bad('存在未支持的整理参数，不能静默忽略转换');
 const conversions=args.conversions??[];
 if(!Array.isArray(conversions))bad('conversions必须为数组');
 const extra=new Set(base.columns);
 for(const c of conversions){column(c.column);if(Object.keys(c).some(k=>!['column','as','type','normalization'].includes(k))||c.type!=='string'||!['none','integer_decimal',undefined].includes(c.normalization)||typeof c.as!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.as)||['__proto__','prototype','constructor'].includes(c.as)||extra.has(c.as))bad('转换须指定原列、新列、type=string及none/integer_decimal；保留原列');extra.add(c.as);}
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
 for(const c of conversions){columns.push(c.as);for(const row of rows)row[c.as]=exactText(row[c.column],c.normalization);}
 if(args.json){
  const j=args.json;column(j.column);
  const pathValid=p=>Array.isArray(p)&&p.every(k=>typeof k==='string'&&k.length>0&&!['__proto__','prototype','constructor'].includes(k)||Number.isSafeInteger(k)&&k>=0);
  if(Object.keys(j).some(k=>!['column','path','records','empty','fields','rowKey','invalid','statusAs'].includes(k))||!pathValid(j.path??[])||!['array','object'].includes(j.records)||!['keep','drop','error'].includes(j.empty)||!Array.isArray(j.fields)||!j.fields.length||typeof j.rowKey!=='string'||columns.includes(j.rowKey)||!j.rowKey||['__proto__','constructor','prototype'].includes(j.rowKey))bad('JSON整理需要实际列、path、records=array/object、empty规则、fields和独立rowKey');
  if(!['error','keep',undefined].includes(j.invalid)||j.invalid==='keep'&&!j.statusAs)bad('保留无效JSON须显式invalid=keep及独立statusAs，不能补成有效空值');
  const names=new Set([...columns,j.rowKey]);if(j.statusAs){if(typeof j.statusAs!=='string'||!j.statusAs||names.has(j.statusAs)||['__proto__','constructor','prototype'].includes(j.statusAs))bad('JSON解析状态列无效');names.add(j.statusAs);}for(const f of j.fields){if(Object.keys(f).some(k=>!['path','as','missing','presenceAs'].includes(k))||!pathValid(f.path)||!['null','error'].includes(f.missing)||typeof f.as!=='string'||!f.as||names.has(f.as)||['__proto__','constructor','prototype'].includes(f.as))bad('JSON字段须显式path、唯一as、missing=null/error');names.add(f.as);if(f.presenceAs){if(typeof f.presenceAs!=='string'||names.has(f.presenceAs)||['__proto__','constructor','prototype'].includes(f.presenceAs))bad('JSON存在性列无效');names.add(f.presenceAs);}}
  const lookup=(obj,path)=>{let v=obj;for(const k of path){if(v===null||typeof v!=='object'||!Object.hasOwn(v,k))return {found:false,value:null};v=v[k];}return {found:true,value:v};};
  const output=[];let emptyRows=0,invalidRows=0,duplicateKeyRows=0;
  for(const row of rows){const raw=row[j.column];let records,status='parsed',invalid=false;if(raw===null||raw==='')records=[];else{let parsed;try{parsed=parseExactJson(raw);}catch(error){if(j.invalid!=='keep'||!error.jsonReason)throw error;invalid=true;invalidRows++;if(error.jsonReason==='duplicate_key')duplicateKeyRows++;status=error.jsonReason==='duplicate_key'?'duplicate_json_key':'invalid_json';records=[null];}if(!invalid){const selected=lookup(parsed,j.path??[]);if(!selected.found)bad('JSON记录路径不存在，不可当成空集合');records=j.records==='array'?selected.value:[selected.value];if(!Array.isArray(records))bad('JSON记录不是声明的数组');}}
   const emptyRecord=!records.length;if(emptyRecord){emptyRows++;if(j.empty==='error')bad('JSON记录为空，须明确保留或排除');if(j.empty==='keep')records=[null];status='empty';}
   for(const [index,record]of records.entries()){if(!emptyRecord&&!invalid&&(record===null||typeof record!=='object'||Array.isArray(record)))bad('JSON每条记录必须为对象');const out={...row,[j.rowKey]:datasetHash([row[args.keyColumn],index])};if(j.statusAs)out[j.statusAs]=status;for(const f of j.fields){const x=record===null?{found:false,value:null}:lookup(record,f.path);if(!x.found&&!invalid&&f.missing==='error')bad('JSON字段路径缺失，不能补成真实null');if(x.value!==null&&typeof x.value==='object')bad('JSON字段不是标量；显式选择嵌套字段，不把对象转占位文字');out[f.as]=x.value;if(f.presenceAs)out[f.presenceAs]=x.found?'present':'missing';}output.push(out);}
  }
  rows=output;columns=[...names];audit={...audit,jsonInputRows:audit.inputCount,jsonEmptyRows:emptyRows,jsonInvalidRows:invalidRows,jsonDuplicateKeyRows:duplicateKeyRows,jsonOutputRows:rows.length,numericValues:'original_json_lexemes_as_text'};
 }
 const data={rows,columns,numericColumns:[...(base.numericColumns??[])],complete:true,readAt:base.readAt,readThroughAt:base.readThroughAt??base.readAt,snapshotId:base.snapshotId,derivation:{kind:'dataset_transform',version:args.json?'tree-filter-json-v3':conversions.length?'tree-filter-text-v2':'tree-filter-v1',args:structuredClone(args),audit:{...audit,outputCount:rows.length}}};
 return data;
}
