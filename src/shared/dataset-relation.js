import {compareExact} from './dataset-summary.js';
import {datasetHash} from './dataset-json.js';
const bad=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};
const field=x=>typeof x==='string'&&x.trim()&&!['__proto__','prototype','constructor'].includes(x);
const columns=(data,names)=>{if(!Array.isArray(names)||!names.length||new Set(names).size!==names.length||names.some(c=>!field(c)||!data.columns.includes(c)))bad('关联键必须是来源实际存在且不重复的字段数组');};
const key=(row,names,nullable=false)=>{const values=names.map(c=>row[c]);if(values.some(v=>v===undefined))bad('关联字段缺失，不能当作真实空值');if(values.some(v=>v===null||v==='')){if(nullable)return null;bad('稳定行键不能为空');}if(values.some(v=>typeof v!=='string'))bad('关联编码须为原始字符串，先明确类型规范化，不猜测数值编码');return JSON.stringify(values);};
function unique(data,names){columns(data,names);const seen=new Set();for(const row of data.rows){const k=key(row,names);if(seen.has(k))bad('稳定行键重复；声明实际复合粒度，不能静默取第一条');seen.add(k);}}
function split(value,options){
 if(value===null||value==='')return [];
 if(typeof value!=='string')bad('拆分字段须为文本或null，不猜测数组/数值语义');
 let values=[options.trim?value.trim():value];
 for(const delimiter of options.delimiters)values=values.flatMap(v=>v.split(delimiter));
 if(options.whitespace)values=values.flatMap(v=>v.split(/\s+/));
 if(options.trim)values=values.map(v=>v.trim());
 values=values.filter(v=>v!=='');return options.duplicates==='set'?[...new Set(values)]:values;
}
function firstBy(rows, order) {
 if (!order) return rows;
 const compare = (a, b) => {
  for (const {column, type, direction} of order) {
   const x = a[column], y = b[column];
   const n = type === 'decimal' ? compareExact(x, y) : x < y ? -1 : x > y ? 1 : 0;
   if (n) return direction === 'desc' ? -n : n;
  }
  return 0;
 };
 if (!rows.length) return rows;
 let best = rows[0], tied = false;
 for (const row of rows.slice(1)) {
  const comparison = compare(row, best);
  if (comparison < 0) { best = row; tied = false; }
  else if (comparison === 0) tied = true;
 }
 if (tied) bad('选取规则首位并列；须声明有业务依据的排序字段，不能按读取顺序选取');
 return [best];
}
// Deterministic fixed data operations only. No code, regex, SQL, filesystem paths or global data access.
export async function buildRelationalDataset(args,load,{check=async()=>{},maxRows=Number.MAX_SAFE_INTEGER,writeRows}={}){
 if(!args||typeof args!=='object'||typeof args.scopeEvidence!=='string'||args.scopeEvidence.trim().length<3||!Array.isArray(args.joins)||!args.joins.length)bad('须声明关联/展开范围依据及joins数组');
 const base=await load(args.datasetRef);if(!base?.complete||base.reportDraft)bad('关联来源必须是当前任务完整数据集');unique(base,args.keyColumns);
 const rowKey=args.rowKey??'relation_key';if(!field(rowKey)||base.columns.includes(rowKey))bad('关联输出行键与来源字段冲突');
 let names=[...base.columns],numericColumns=[...(base.numericColumns??[])],provenance=Object.fromEntries(names.map(c=>[c,{datasetRef:args.datasetRef,column:c}]));
 const inputs=[base],audits=[];
 let work=(function*(){for(const row of base.rows)yield {row,identity:[key(row,args.keyColumns)]};})();
 for(const join of args.joins){
  if(!join||typeof join!=='object'||Array.isArray(join))bad('joins每项必须为显式关联参数对象');
  await check();const right=await load(join.datasetRef);
  if(!right?.complete||right.reportDraft)bad('右来源必须是当前授权完整数据集');
  columns({columns:names},join.leftKeys);columns(right,join.rightKeys);columns(right,join.rightRowKey);
  if(join.leftKeys.length!==join.rightKeys.length||!['lookup','expand'].includes(join.relationship)||!['keep','drop','error'].includes(join.empty)||!['keep','drop','error'].includes(join.unmatched)||!Array.isArray(join.fields))bad('关联须明确同宽键、relationship=lookup/expand、empty及unmatched=keep/drop/error和fields');
  if(join.split){const s=join.split;if(!Array.isArray(s.delimiters)||s.delimiters.some(v=>typeof v!=='string'||!v.length)||!['set','preserve'].includes(s.duplicates)||typeof s.trim!=='boolean'||typeof s.whitespace!=='boolean')bad('文本拆分只作用于第一个左键，明确字面delimiters、trim、whitespace、duplicates=set/preserve；不接收正则');}
  for(const f of join.fields){if(!f||typeof f!=='object'||!right.columns.includes(f.column)||!field(f.as)||names.includes(f.as)||f.as===rowKey)bad('关联输出列不存在、重复或覆盖原字段');names.push(f.as);if(right.numericColumns?.includes(f.column))numericColumns.push(f.as);provenance[f.as]={datasetRef:join.datasetRef,column:f.column};}
  const order = join.selectFirstBy;
  if (order !== undefined) {
   if (join.relationship !== 'lookup' || join.split || !Array.isArray(order) || !order.length ||
       order.some(o => !o || !['text','decimal'].includes(o.type) || !['asc','desc'].includes(o.direction))) {
    bad('selectFirstBy需唯一查找、非拆分键与明示的text/decimal、asc/desc排序');
   }
   columns(right, order.map(o => o.column));
  }
  const rightOrder=join.split?.duplicates==='set'?new Map():null;
  const index=new Map(), rightIdentities=new Set();
  let emptyRightRows=0;
  for(const [position,row] of right.rows.entries()){
   if(position%1000===0)await check();
   if(rightOrder)rightOrder.set(row,position);
   if(join.fields.some(f=>row[f.column]===undefined))bad('右来源行缺少已声明输出字段，不可当作null');
   const k=key(row,join.rightKeys,true);
   // An empty join key cannot match. Only rows that can match need a stable identity.
   if(k===null){emptyRightRows++;continue;}
   const identity=key(row,join.rightRowKey);
   if(rightIdentities.has(identity))bad('稳定行键重复；声明实际复合粒度，不能静默取第一条');
   rightIdentities.add(identity);
   for(const {column,type} of order??[]){
    if(typeof row[column]!=='string'||!row[column])bad('选取规则排序值不能为空，先按已核实业务口径整理');
    if(type==='decimal')compareExact(row[column],row[column]);
   }
   const group=index.get(k)??[];
   if(group.length&&join.relationship==='lookup'&&!order)bad('lookup右键重复；一对多须明确expand及实际右侧行键');
   group.push(row);index.set(k,group);
  }
  if (order) for (const [k, group] of index) index.set(k, firstBy(group, order));
  const audit={inputRows:0,rightRows:right.rows.length,matchedInputRows:0,emptyInputRows:0,unmatchedInputRows:0,outputRows:0,duplicateTokens:0,unmatchedKeys:[],scopeEvidence:args.scopeEvidence};
  if(emptyRightRows)audit.emptyRightRows=emptyRightRows;
  const input=work;
  work=(async function*(){
  for await(const item of input){
   if(audit.inputRows++%1000===0)await check();let keys;
   if(join.split){
    const [splitColumn,...otherColumns]=join.leftKeys;
    const tokens=split(item.row[splitColumn],{...join.split,duplicates:'preserve'});
    const distinct=new Set(tokens);
    audit.duplicateTokens+=tokens.length-distinct.size;
    const otherKey=key(item.row,otherColumns,true);
    const otherValues=otherKey===null?null:JSON.parse(otherKey);
    keys=otherValues===null?[]:(join.split.duplicates==='set'?[...distinct]:tokens).map(v=>JSON.stringify([v,...otherValues]));
   }
   else{const k=key(item.row,join.leftKeys,true);keys=k===null?[]:[k];}
   // Set membership follows right-source order and does not repeat rows for duplicate tokens.
   let matches=[];
   if(join.split?.duplicates==='set'){const wanted=new Set(keys);for(const k of wanted)for(const row of index.get(k)??[])matches.push(row);matches.sort((a,b)=>rightOrder.get(a)-rightOrder.get(b));}
   else for(const k of keys)for(const row of index.get(k)??[])matches.push(row);
   const empty=!keys.length,policy=empty?join.empty:join.unmatched;
   if(empty)audit.emptyInputRows++;else if(!matches.length){audit.unmatchedInputRows++;if(audit.unmatchedKeys.length<3)audit.unmatchedKeys.push(keys.slice(0,3));}else audit.matchedInputRows++;
   if(!matches.length){if(policy==='error')bad(empty?'关联左键为空：请核对真实空配置处理':'关联左键未匹配：请核对范围和编码，不能补零');if(policy==='keep')matches=[null];}
   const occurrence=join.split?.duplicates==='preserve'?new Map():null;
   for(const row of matches){const identity=row?key(row,join.rightRowKey):null,ordinal=occurrence?.get(identity)??0;occurrence?.set(identity,ordinal+1);
    const output={...item.row};for(const f of join.fields)output[f.as]=row?row[f.column]:null;
    if(++audit.outputRows>maxRows)bad('关联展开超过当前已配置的报表行数范围，已有来源保留');
    if(audit.outputRows%1000===0)await check();
    yield {row:output,identity:[...item.identity,identity,ordinal]};
   }
  }
  })();
  audits.push(audit);inputs.push(right);
 }
 if(args.project!==undefined){
  if(!Array.isArray(args.project)||!args.project.length)bad('project须为非空的实际字段投影数组');
  const outputs=new Set();
  for(const f of args.project){if(!f||typeof f!=='object'||!names.includes(f.column)||!field(f.as)||f.as===rowKey||outputs.has(f.as))bad('project字段不存在、输出重复或覆盖行键');outputs.add(f.as);
   if(f.labels!==undefined&&(!f.labels||Array.isArray(f.labels)||typeof f.labels!=='object'||Object.values(f.labels).some(v=>typeof v!=='string')||!['keep','error'].includes(f.unmapped)||numericColumns.includes(f.column)))bad('枚举映射需要文本labels及unmapped=keep/error；金额数值列不可改标签');
  }
  const input=work;
  work=(async function*(){
   for await(const item of input){
    const row=Object.fromEntries(args.project.map(f=>{
     let value=item.row[f.column];
     if(value===undefined)bad('project行缺少来源字段');
     if(value!==null&&f.labels){
      if(Object.hasOwn(f.labels,value))value=f.labels[value];
      else if(f.unmapped==='error')bad('枚举值未核实：'+f.column+'='+JSON.stringify(value));
     }
     return [f.as,value];
    }));
    yield {...item,row};
   }
  })();
  provenance=Object.fromEntries(args.project.map(f=>[f.as,provenance[f.column]]));numericColumns=args.project.filter(f=>numericColumns.includes(f.column)).map(f=>f.as);names=args.project.map(f=>f.as);
 }
 const output=(async function*(){for await(const item of work)yield {...item.row,[rowKey]:datasetHash(item.identity)};})();
 const finish=rows=>({rows,columns:[...names,rowKey],numericColumns,complete:true,readAt:inputs.map(d=>d.readAt).sort()[0],readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),snapshotId:inputs.every(d=>d.snapshotId===base.snapshotId)?base.snapshotId:datasetHash(inputs.map(d=>d.snapshotId)),derivation:{kind:'dataset_relation',version:1,args:structuredClone(args),audit:{sourceRows:base.rows.length,outputRows:audits.at(-1).outputRows,joins:audits},provenance}});
 if(writeRows)return writeRows(output,finish);
 const rows=[];for await(const row of output)rows.push(row);
 return finish(rows);
}
