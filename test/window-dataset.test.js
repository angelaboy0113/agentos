import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {buildWindowDataset} from '../src/shared/window-dataset.js';import {verifyPeriodDataset} from '../src/shared/period-dataset.js';import {ReportDatasets} from '../src/runner/report-datasets.js';
const data=(rows,columns=Object.keys(rows[0]??{}))=>({rows,columns,complete:true,readAt:'2026-03-01T00:00:00Z',snapshotId:'snapshot'});
const p=data([{owner:'A',id:'1'},{owner:'A',id:'2'},{owner:'B',id:'3'},{owner:'C',id:'4'}]);
const events=data([{account:'A',object:'1',at:'2025-12-31'},{account:'A',object:'1',at:'2026-01-01'},{account:'A',object:'2',at:'2026-02-01'},{account:'B',object:'3',at:'2025-01-01'}]);
const args={populationRef:'p',populationKeys:['owner','id'],groupColumns:['owner'],timeType:'civil_day',windows:[{start:'2025-12-01',end:'2026-03-01',countColumn:'quarter',percentageColumn:'quarter_pct'},{start:'2026-02-01',end:'2026-03-01',countColumn:'month',percentageColumn:'month_pct'}],sources:[{datasetRef:'e',populationKeys:['account','object'],timeColumn:'at'}]};
const build=(a=args,source=events,pop=p)=>buildWindowDataset(a,async ref=>ref==='p'?pop:source);
test('all groups/windows in one pass, repeated events and sources union objects, sparse groups remain zero',async()=>{
 const d=await build();assert.deepEqual(d.rows.map(r=>[r.owner,r.population_count,r.quarter,r.quarter_pct,r.month]),[['A','2','2','100.00%','1'],['B','1','0','0.00%','0'],['C','1','0','0.00%','0']]);
 const two=await build({...args,sources:[...args.sources,{...args.sources[0],datasetRef:'second'}]});assert.deepEqual(d.rows,two.rows);
 assert.equal(d.derivation.audit.sources[0].outsideWindowRows,1);await verifyPeriodDataset(d,ref=>ref==='p'?p:events);
 d.rows[0].quarter='1';await assert.rejects(verifyPeriodDataset(d,ref=>ref==='p'?p:events),/重算/);
});
test('explicit instant offsets compare moments, boundaries are half open and civil dates normalize without timezone guessing',async()=>{
 const a={...args,timeType:'instant',windows:[{start:'2026-01-01T00:00:00+08:00',end:'2026-01-02T00:00:00+08:00',countColumn:'n'}]};
 const d=await build(a,data([{account:'A',object:'1',at:'2025-12-31T16:00:00Z'},{account:'A',object:'2',at:'2026-01-01T16:00:00Z'}]));assert.equal(d.rows[0].n,'1');
 assert.equal((await build(args,data([{account:'A',object:'1',at:20260228}]))).rows[0].month,'1');
 const month={...args,timeType:'civil_month',windows:[{start:'2025-12',end:'2026-03',countColumn:'n'}]};assert.equal((await build(month,data([{account:'A',object:'1',at:202601}]))).rows[0].n,'1');
});
test('invalid/leap/null/ambiguous times fail even on records outside population',async()=>{
 for(const at of [null,'','2025-02-29','2026-13-01','2026-02-31','2026-02-01T00:00:00Z'])await assert.rejects(build({...args,sources:[{...args.sources[0],outsidePopulation:'exclude',outsideEvidence:'different owner excluded'}]},data([{account:'other',object:'outside',at}])),e=>e.code==='REPORT_INPUT');
 assert.equal((await build({...args,windows:[{start:'2024-02-01',end:'2024-03-01',countColumn:'n'}]},data([{account:'A',object:'1',at:'2024-02-29'}]))).rows[0].n,'1');
 await assert.rejects(build({...args,timeType:'instant',windows:[{start:'2026-01-01',end:'2026-03-01',countColumn:'n'}]}),/明确时区/);
});
test('population duplicates require explicit evidence, conflicting ownership never silently chooses a row',async()=>{
 const duplicate=data([...p.rows,p.rows[0]]);await assert.rejects(build(args,events,duplicate),/重复/);
 const d=await build({...args,populationDuplicates:'deduplicate',duplicateEvidence:'same master relation repeated'},events,duplicate);assert.equal(d.rows[0].population_count,'2');assert.equal(d.derivation.audit.populationDuplicates,1);
 await assert.rejects(build({...args,populationDuplicates:'deduplicate'},events,duplicate),/依据/);
});
test('unmatched identities require explicit exclusion and empty source samples cannot produce false zeros',async()=>{
 const e=data([{account:'missing',object:'x',at:'2026-01-01'}]);await assert.rejects(build(args,e),/范围外/);
 const d=await build({...args,sources:[{...args.sources[0],outsidePopulation:'exclude',outsideEvidence:'Only current master population is requested'}]},e);assert.equal(d.derivation.audit.sources[0].outsidePopulationRows,1);
 await assert.rejects(build(args,{...events,complete:false}),/来源必须完整/);
 await assert.rejects(build({...args,sources:[]}),/不能假装无发生额/);
 const empty=data([],events.columns);assert.ok((await build(args,empty)).rows.every(r=>r.quarter==='0'));
});
async function fixture(t,scope='A-prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'window-store-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','JOB-test'),d=new ReportDatasets({maxRows:'all',directory,scope,snapshotWindowMs:null});
 const capture=(sql,base)=>d.collect({sql,params:[],columns:base.columns,recipe:{tool:'group_dataset',args:{table:'raw_'+Buffer.from(sql).toString('hex').slice(0,48)}}},async()=>[base.rows]);
 const population=await capture('SELECT owner,id FROM master',p),source=await capture('SELECT owner,object,at FROM events',events);
 const a={...args,populationRef:population.datasetRef,sources:[{...args.sources[0],datasetRef:source.datasetRef}]},w=await d.window(a);return {root,d,directory,capture,population,source,a,w};
}
test('same-job save/restart/replay verifies all dependencies; other system/tier cannot restore',async t=>{
 const f=await fixture(t);f.d.clear();const fresh=new ReportDatasets({maxRows:'all',directory:f.directory,scope:'A-prd'}),w=await fresh.restore(f.w.datasetRef);await fresh.verifyDerived(w);assert.equal(w.rows[0].quarter,'2');
 const wrong=new ReportDatasets({maxRows:'all',directory:f.directory,scope:'B-sit'});await assert.rejects(wrong.restore(f.w.datasetRef),/范围/);
 const [a,b]=await Promise.all([fixture(t,'systemA-prd'),fixture(t,'systemB-sit')]);assert.notEqual(a.w.datasetRef,b.w.datasetRef);
});
test('independent window baselines and actual CSV are checked by group; same-source derivation cannot self-prove',async t=>{
 const f=await fixture(t),basePop=await f.capture('SELECT distinct owner,id FROM separate_master',p),baseEvents=await f.capture('SELECT distinct owner,object,at FROM separate_events',events);
 const independent=await f.d.window({...f.a,populationRef:basePop.datasetRef,sources:[{...f.a.sources[0],datasetRef:baseEvents.datasetRef}]});
 const groups=data(f.w.preview.map(r=>({id:r.group_key})),['id']),population=await f.capture('SELECT independent_group_key FROM population_groups',groups);
 const draft=await f.d.compose({sources:[{name:'s1',datasetRef:f.w.datasetRef,keyColumn:'group_key'}],columns:[{label:'对象',value:{op:'field',source:'s1',column:'owner'}},{label:'窗口数量',value:{op:'field',source:'s1',column:'quarter'}}]});
 const a={datasetRef:draft.datasetRef,requirement:'完整对象窗口数量',expectedColumns:draft.columns,scopeEvidence:'完整主对象范围',populationRef:population.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'显式窗口唯一对象数',evidence:'独立读取来源与窗口定义'})),checks:[{source:'s1',column:'quarter',referenceRef:f.w.datasetRef,referenceColumn:'quarter',evidence:'同一个来源不应通过'}]};
 await assert.rejects(f.d.finalize(a),/同一原始查询/);
 const result=await f.d.finalize({...a,checks:[{...a.checks[0],referenceRef:independent.datasetRef,evidence:'不同原始查询按相同窗口逐对象统计'}]});assert.equal(result.coverage.rowCount,3);const csv=await readFile(path.join(f.directory,result.exportFile.id+'.csv'),'utf8');assert.match(csv,/窗口数量/);assert.match(csv,/"A","2"/);
});

test('percentage text compiles to numerator/denominator fields so both remain required independent components',async t=>{
 const f=await fixture(t),draft=await f.d.compose({sources:[{name:'s1',datasetRef:f.w.datasetRef,keyColumn:'group_key'}],columns:[{label:'对象',value:{op:'field',source:'s1',column:'owner'}},{label:'占比',value:{op:'field',source:'s1',column:'quarter_pct'}}]});
 const inspected=await f.d.inspect({datasetRef:draft.datasetRef});assert.equal(inspected.reportDraft.columns[1].value.op,'percentage');assert.deepEqual(inspected.reportDraft.finalization.requiredChecks.map(c=>c.column).sort(),['population_count','quarter']);
 const bp=await f.capture('SELECT independent master identities',p),be=await f.capture('SELECT independent event identities',events),b=await f.d.window({...f.a,populationRef:bp.datasetRef,sources:[{...f.a.sources[0],datasetRef:be.datasetRef}]}),pop=await f.capture('SELECT independent group keys',data(f.w.preview.map(r=>({id:r.group_key})),['id']));
 const final=await f.d.finalize({datasetRef:draft.datasetRef,requirement:'完整分组占比文件',expectedColumns:draft.columns,scopeEvidence:'完整主对象分组范围',populationRef:pop.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'显式窗口对象占比',evidence:'独立对象、事件及窗口依据'})),checks:['quarter','population_count'].map(column=>({source:'s1',column,referenceRef:b.datasetRef,referenceColumn:column,evidence:'不同原始对象与事件来源，逐组核对分子分母'}))});
 const csv=await readFile(path.join(f.directory,final.exportFile.id+'.csv'),'utf8');assert.match(csv,/100.00%/);assert.equal(final.totals.length,2);

});
test('equal grand total with wrong group allocation fails independent window row verification',async t=>{
 const f=await fixture(t),other=await f.capture('SELECT object,date FROM different_raw_events',data([{account:'A',object:'1',at:'2026-01-01'},{account:'B',object:'3',at:'2026-01-01'}]));
 const b=await f.d.window({...f.a,sources:[{...f.a.sources[0],datasetRef:other.datasetRef}]}),population=await f.capture('SELECT group_keys FROM independent_groups',data(f.w.preview.map(r=>({id:r.group_key})),['id']));
 const draft=await f.d.compose({sources:[{name:'s1',datasetRef:f.w.datasetRef,keyColumn:'group_key'}],columns:[{label:'窗口数量',value:{op:'field',source:'s1',column:'quarter'}}]});
 await assert.rejects(f.d.finalize({datasetRef:draft.datasetRef,requirement:'完整窗口数量',expectedColumns:draft.columns,scopeEvidence:'完整主对象分组',populationRef:population.datasetRef,populationKey:'id',columnRules:[{label:draft.columns[0],definition:'当前窗口唯一对象数',evidence:'窗口定义及源记录'}],checks:[{source:'s1',column:'quarter',referenceRef:b.datasetRef,referenceColumn:'quarter',evidence:'不同原始来源同窗口核对'}]}),/逐对象数值不一致/);
});
test('refresh replays window raw dependencies once and validates rebuilt CSV without keeping old formulas',async t=>{
 const f=await fixture(t),bp=await f.capture('SELECT distinct owner,id FROM other_master',p),be=await f.capture('SELECT distinct account,object,at FROM other_events',events),baseline=await f.d.window({...f.a,populationRef:bp.datasetRef,sources:[{...f.a.sources[0],datasetRef:be.datasetRef}]}),population=await f.capture('SELECT group_key FROM independent_groups',data(f.w.preview.map(r=>({id:r.group_key})),['id']));
 const draft=await f.d.compose({sources:[{name:'s1',datasetRef:f.w.datasetRef,keyColumn:'group_key'}],columns:[{label:'窗口数量',value:{op:'field',source:'s1',column:'quarter'}}]});
 const a={datasetRef:draft.datasetRef,requirement:'完整窗口数量',expectedColumns:draft.columns,scopeEvidence:'主对象完整分组',populationRef:population.datasetRef,populationKey:'id',columnRules:[{label:draft.columns[0],definition:'当前窗口去重对象数',evidence:'显式日期范围及完整来源'}],checks:[{source:'s1',column:'quarter',referenceRef:baseline.datasetRef,referenceColumn:'quarter',evidence:'不同原始查询同窗口验证'}]};
 const originals=new Map([...f.d.datasets.values()].filter(d=>d.recipe).map(d=>[d.recipe.args.table,d]));let calls=0,starts=0;
 const result=await f.d.refresh(a,{begin:async()=>{starts++;},reload:async recipe=>{calls++;const d=originals.get(recipe.args.table);return f.d.collect({...d.queryDefinition,columns:d.columns,recipe},async()=>[d.rows]);}});
 assert.equal(starts,1);assert.equal(calls,5);assert.equal(result.coverage.rowCount,3);const current=await f.d.restore(result.refreshedDatasetRef),windowRef=current.reportDraft.sources[0].datasetRef;assert.notEqual(windowRef,f.w.datasetRef);await f.d.verifyDerived(await f.d.restore(windowRef));
});

test('invalid report expressions remain recoverable input errors after percentage expansion',async t=>{
 const f=await fixture(t);await assert.rejects(f.d.compose({sources:[{name:'s1',datasetRef:f.w.datasetRef,keyColumn:'group_key'}],columns:[{label:'非法表达式',value:{op:'add',args:'not-an-array'}}]}),e=>e.code==='REPORT_INPUT');
});
