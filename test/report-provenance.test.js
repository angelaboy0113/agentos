import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';import {summarizeDataset} from '../src/shared/dataset-summary.js';
const data=rows=>({rows,columns:Object.keys(rows[0]),complete:true,numericColumns:[],readAt:'2026-01-01T00:00:00Z',snapshotId:'fixed'});
test('exact weighted sum supports grouped amounts/counts, null policies and precision without floating point',()=>{
 const b=data([{owner:'A',price:'9007199254740993.01',n:'2'},{owner:'A',price:'0.01',n:'3'}]);
 const args={datasetRef:'source',groupColumns:['owner'],aggregates:[{op:'weighted_sum',column:'price',weightColumn:'n',as:'total',nulls:'error'}]};assert.equal(summarizeDataset(args,b).rows[0].total,'18014398509481986.05');
 for(const nulls of ['error','empty','zero']){const a={...args,aggregates:[{...args.aggregates[0],nulls}]},d=data([{owner:'A',price:null,n:'2'}]);if(nulls==='error')assert.throws(()=>summarizeDataset(a,d));else assert.equal(summarizeDataset(a,d).rows[0].total,nulls==='empty'?null:'0');}
 assert.throws(()=>summarizeDataset(args,data([{owner:'A',price:'0.000000000001',n:'0.1'}])),/不能静默舍入/);
});
async function fixture(t,scope='A/prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'proof-'));t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({maxRows:'all',directory:root,scope});
 const capture=async(table,rows)=>d.collect({sql:'SELECT '+table,params:[],columns:Object.keys(rows[0]),recipe:{tool:'group_dataset',args:{table}}},async()=>[rows]);return {d,capture};
}
test('renamed and nested aggregate provenance reaches original fields across lookup/relation and survives restore in two scopes',async t=>{
 await Promise.all(['A/prd','B/sit'].map(async scope=>{
  const {d,capture}=await fixture(t,scope),left=await capture('detail',[{id:'d1',code:'A',group:'g'}]),right=await capture('independent_amount_groups',[{id:'g',price:'2.01',n:'3'}]);
  const joined=await d.enrich({datasetRef:left.datasetRef,keyColumn:'id',lookups:[{name:'prices',datasetRef:right.datasetRef,sourceColumn:'group',targetColumn:'id',fields:[{column:'price',as:'base_amount'}],missing:'error'}]});
  const s=await d.summarize({datasetRef:joined.datasetRef,groupColumns:['code'],aggregates:[{op:'sum',column:'base_amount',as:'renamed_total',nulls:'error'}]});
  assert.equal(await d.rawEvidence(await d.restore(s.datasetRef),'renamed_total'),await d.rawEvidence(await d.restore(right.datasetRef),'price'));
  const weighted=await d.summarize({datasetRef:right.datasetRef,groupColumns:['id'],aggregates:[{op:'weighted_sum',column:'price',weightColumn:'n',as:'independent_total',nulls:'error'}]});const saved=await d.restore(weighted.datasetRef);await d.verifyDerived(saved);assert.equal(saved.rows[0].independent_total,'6.03');assert.equal(await d.rawEvidence(saved,'independent_total'),await d.rawEvidence(await d.restore(right.datasetRef),'price'));
 }));
});
test('keyed raw window baselines pass exact per-object checking; scalar, mismatched and shared-query proofs still fail',async t=>{
 const {d,capture}=await fixture(t),p=await capture('master',[{owner:'A',id:'1'},{owner:'B',id:'2'}]),events=await capture('events',[{owner:'A',id:'1',date:'2026-01-02'}]);
 const w=await d.window({populationRef:p.datasetRef,populationKeys:['owner','id'],groupColumns:['owner'],timeType:'civil_day',windows:[{start:'2026-01-01',end:'2026-02-01',countColumn:'visits'}],sources:[{datasetRef:events.datasetRef,populationKeys:['owner','id'],timeColumn:'date'}]}),draft=await d.compose({sources:[{name:'s1',datasetRef:w.datasetRef,keyColumn:'owner'}],columns:[{label:'对象',value:{op:'key'}},{label:'拜访数',value:{op:'field',source:'s1',column:'visits'}}]});
 const pop=await capture('independent_owners',[{owner:'A'},{owner:'B'}]),ref=await capture('independent_group_count',[{owner:'A',visits:'1'},{owner:'B',visits:'0'}]);
 const a={datasetRef:draft.datasetRef,requirement:'完整对象拜访数',scopeEvidence:'合成独立同窗口逐对象基准',expectedColumns:draft.columns,populationRef:pop.datasetRef,populationKey:'owner',columnRules:draft.columns.map(label=>({label,definition:'完整真实对象字段',evidence:'合成明确定义的窗口'})),checks:[{source:'s1',column:'visits',referenceRef:ref.datasetRef,referenceColumn:'visits',referenceKey:'owner',evidence:'独立分组原始计数同窗口'}]};
 assert.ok((await d.finalize(a)).exportFile);
 const wrong=await capture('wrong_counts',[{owner:'A',visits:'0'},{owner:'B',visits:'1'}]);await assert.rejects(d.finalize({...a,checks:[{...a.checks[0],referenceRef:wrong.datasetRef}]}),/逐对象数值不一致/);
 const scalar=await capture('scalar_count',[{visits:'1'}]);await assert.rejects(d.finalize({...a,checks:[{...a.checks[0],referenceRef:scalar.datasetRef}]}),/无对象键的总计/);
 await assert.rejects(d.finalize({...a,checks:[{...a.checks[0],referenceRef:w.datasetRef}]}),/同一原始查询/);
});
test('expanded reference cannot claim independent weighted amounts when multiplicity comes from original details',async t=>{
 const {d,capture}=await fixture(t),main=await capture('detail',[{id:'d1',owner:'A',g:'g',amount:'3'}]),right=await capture('reference',[{id:'g',amount:'3'}]);
 const joined=await d.relate({datasetRef:main.datasetRef,keyColumns:['id'],scopeEvidence:'合成一对多依赖不得冒充独立计数',joins:[{datasetRef:right.datasetRef,leftKeys:['g'],rightKeys:['id'],rightRowKey:['id'],relationship:'lookup',fields:[{column:'amount',as:'reference_amount'}],empty:'error',unmatched:'error'}]});
 const refs=await d.summarize({datasetRef:joined.datasetRef,groupColumns:['owner'],aggregates:[{op:'sum',column:'reference_amount',as:'total',nulls:'error'}]});
 const proof=await d.windowEvidence(await d.restore(refs.datasetRef),'total');assert.equal(proof.ids.length,2);
});
