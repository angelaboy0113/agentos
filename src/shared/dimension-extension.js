const bad=message=>{throw Object.assign(new Error('显式维度补全：'+message),{code:'REPORT_INPUT'});};
const field=s=>typeof s==='string'&&s.length>0&&!['__proto__','prototype','constructor'].includes(s);
// Only display members. Measures must come from actual independently verified sources.
export function extendDimension(args,base){
 if(!args||Object.keys(args).some(k=>!['datasetRef','keyColumn','members','scopeEvidence'].includes(k)))bad('未知参数，未执行追加');
 if(!base?.complete||base.reportDraft||!Array.isArray(base.rows)||!base.columns?.includes(args.keyColumn)||base.numericColumns?.length)bad('需要完整的非数值主对象维度来源；不能追加业务数值');
 if(typeof args.scopeEvidence!=='string'||args.scopeEvidence.trim().length<3||!Array.isArray(args.members)||!args.members.length)bad('需要原需求/源码范围依据和明确的members');
 if(base.columns.some(c=>!field(c)))bad('来源字段无效');
 const keys=new Set();for(const row of base.rows){const k=row[args.keyColumn];if(typeof k!=='string'||!k||keys.has(k))bad('原主键为空、类型不明确或重复');keys.add(k);}
 const added=[];for(const member of args.members){
  if(!member||Array.isArray(member)||typeof member!=='object'||Object.keys(member).some(c=>!base.columns.includes(c)||!field(c))||Object.values(member).some(v=>v!==null&&typeof v!=='string'))bad('members仅支持已有字段的文本标签/null，不支持数值、代码或新字段');
  const k=member[args.keyColumn];if(typeof k!=='string'||!k||keys.has(k))bad('新增主键为空、重复或与已有对象碰撞');keys.add(k);
  added.push(Object.fromEntries(base.columns.map(c=>[c,Object.hasOwn(member,c)?member[c]:null])));
 }
 return {rows:[...base.rows.map(r=>({...r})),...added],columns:[...base.columns],numericColumns:[],complete:true,readAt:base.readAt,readThroughAt:base.readThroughAt??base.readAt,snapshotId:base.snapshotId,derivation:{kind:'dimension_extension',version:1,args:structuredClone(args),audit:{sourceRows:base.rows.length,addedMembers:added.map(r=>r[args.keyColumn]),outputRows:base.rows.length+added.length,addedRowsAre:'explicit_reporting_members_not_database_records'}}};
}
