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
// Deterministic fixed data operations only. No code, regex, SQL, filesystem paths or global data access.
export async function buildRelationalDataset(args,load,{check=async()=>{},maxRows=Number.MAX_SAFE_INTEGER}={}){
 if(typeof args.scopeEvidence!=='string'||args.scopeEvidence.trim().length<3||!Array.isArray(args.joins)||!args.joins.length)bad('须声明关联/展开范围依据及joins数组');
 const base=await load(args.datasetRef);if(!base?.complete||base.reportDraft)bad('关联来源必须是当前任务完整数据集');unique(base,args.keyColumns);
 const rowKey=args.rowKey??'relation_key';if(!field(rowKey)||base.columns.includes(rowKey))bad('关联输出行键与来源字段冲突');
 let names=[...base.columns],numericColumns=[...(base.numericColumns??[])],provenance=Object.fromEntries(names.map(c=>[c,{datasetRef:args.datasetRef,column:c}]));
 const inputs=[base],audits=[];let work=base.rows.map(row=>({row:{...row},identity:[key(row,args.keyColumns)]}));
 for(const join of args.joins){
  await check();const right=await load(join.datasetRef);
  if(!right?.complete||right.reportDraft)bad('右来源必须是当前授权完整数据集');unique(right,join.rightRowKey);
  columns({columns:names},join.leftKeys);columns(right,join.rightKeys);
  if(join.leftKeys.length!==join.rightKeys.length||!['lookup','expand'].includes(join.relationship)||!['keep','drop','error'].includes(join.empty)||!['keep','drop','error'].includes(join.unmatched)||!Array.isArray(join.fields))bad('关联须明确同宽键、relationship=lookup/expand、empty及unmatched=keep/drop/error和fields');
  if(join.split){const s=join.split;if(join.leftKeys.length!==1||!Array.isArray(s.delimiters)||s.delimiters.some(v=>typeof v!=='string'||!v.length)||!['set','preserve'].includes(s.duplicates)||typeof s.trim!=='boolean'||typeof s.whitespace!=='boolean')bad('文本拆分仅单键，明确字面delimiters、trim、whitespace、duplicates=set/preserve；不接收正则');}
  for(const f of join.fields){if(!right.columns.includes(f.column)||!field(f.as)||names.includes(f.as)||f.as===rowKey)bad('关联输出列不存在、重复或覆盖原字段');names.push(f.as);if(right.numericColumns?.includes(f.column))numericColumns.push(f.as);provenance[f.as]={datasetRef:join.datasetRef,column:f.column};}
  const rightOrder=new Map(right.rows.map((r,i)=>[r,i]));
  const index=new Map();for(const row of right.rows){if(join.fields.some(f=>row[f.column]===undefined))bad('右来源行缺少已声明输出字段，不可当作null');const k=key(row,join.rightKeys,true);if(k===null)continue;const group=index.get(k)??[];if(group.length&&join.relationship==='lookup')bad('lookup右键重复；一对多须明确expand及实际右侧行键');group.push(row);index.set(k,group);}
  const audit={inputRows:work.length,rightRows:right.rows.length,matchedInputRows:0,emptyInputRows:0,unmatchedInputRows:0,outputRows:0,duplicateTokens:0,unmatchedKeys:[],scopeEvidence:args.scopeEvidence};
  const next=[];
  for(const [i,item] of work.entries()){
   if(i%1000===0)await check();let keys;
   if(join.split){const value=item.row[join.leftKeys[0]],tokens=split(value,{...join.split,duplicates:'preserve'});audit.duplicateTokens+=tokens.length-new Set(tokens).size;keys=(join.split.duplicates==='set'?[...new Set(tokens)]:tokens).map(v=>JSON.stringify([v]));}
   else{const k=key(item.row,join.leftKeys,true);keys=k===null?[]:[k];}
   // Set membership follows right-source order and does not repeat rows for duplicate tokens.
   let matches=[];
   if(join.split?.duplicates==='set'){const wanted=new Set(keys);for(const k of wanted)for(const row of index.get(k)??[])matches.push(row);matches.sort((a,b)=>rightOrder.get(a)-rightOrder.get(b));}
   else for(const k of keys)for(const row of index.get(k)??[])matches.push(row);
   const empty=!keys.length,policy=empty?join.empty:join.unmatched;
   if(empty)audit.emptyInputRows++;else if(!matches.length){audit.unmatchedInputRows++;if(audit.unmatchedKeys.length<3)audit.unmatchedKeys.push(keys.slice(0,3));}else audit.matchedInputRows++;
   if(!matches.length){if(policy==='error')bad(empty?'关联左键为空：请核对真实空配置处理':'关联左键未匹配：请核对范围和编码，不能补零');if(policy==='keep')matches=[null];}
   const occurrence=new Map();
   for(const row of matches){const identity=row?key(row,join.rightRowKey):null,ordinal=occurrence.get(identity)??0;occurrence.set(identity,ordinal+1);
    const output={...item.row};for(const f of join.fields)output[f.as]=row?row[f.column]:null;
    next.push({row:output,identity:[...item.identity,identity,ordinal]});if(next.length>maxRows)bad('关联展开超过当前已配置的报表行数范围，已有来源保留');
   }
  }
  audit.outputRows=next.length;audits.push(audit);work=next;inputs.push(right);
 }
 if(args.project!==undefined){
  if(!Array.isArray(args.project)||!args.project.length)bad('project须为非空的实际字段投影数组');
  const outputs=new Set();
  for(const f of args.project){if(!names.includes(f.column)||!field(f.as)||f.as===rowKey||outputs.has(f.as))bad('project字段不存在、输出重复或覆盖行键');outputs.add(f.as);
   if(f.labels!==undefined&&(!f.labels||Array.isArray(f.labels)||typeof f.labels!=='object'||Object.values(f.labels).some(v=>typeof v!=='string')||!['keep','error'].includes(f.unmapped)||numericColumns.includes(f.column)))bad('枚举映射需要文本labels及unmapped=keep/error；金额数值列不可改标签');
  }
  work=work.map(x=>({...x,row:Object.fromEntries(args.project.map(f=>{let v=x.row[f.column];if(v===undefined)bad('project行缺少来源字段');if(v!==null&&f.labels){if(Object.hasOwn(f.labels,v))v=f.labels[v];else if(f.unmapped==='error')bad('枚举值未核实：'+f.column+'='+JSON.stringify(v));}return [f.as,v];}))}));
  provenance=Object.fromEntries(args.project.map(f=>[f.as,provenance[f.column]]));numericColumns=args.project.filter(f=>numericColumns.includes(f.column)).map(f=>f.as);names=args.project.map(f=>f.as);
 }
 const rows=work.map(x=>({...x.row,[rowKey]:datasetHash(x.identity)}));
 return {rows,columns:[...names,rowKey],numericColumns,complete:true,readAt:inputs.map(d=>d.readAt).sort()[0],readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),snapshotId:inputs.every(d=>d.snapshotId===base.snapshotId)?base.snapshotId:datasetHash(inputs.map(d=>d.snapshotId)),derivation:{kind:'dataset_relation',version:1,args:structuredClone(args),audit:{sourceRows:base.rows.length,outputRows:rows.length,joins:audits},provenance}};
}
