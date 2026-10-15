import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'agentos-enrich-'));t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({maxRows:100,directory:root,scope:'env'});const collect=(sql,rows)=>d.collect({sql,params:[],columns:Object.keys(rows[0]),numericColumns:[]},async()=>[rows]);return {d,collect,root};}
test('bounded dataset lookups retain every master object and follow explicit parent keys without arbitrary SQL',async t=>{
 const f=await fixture(t),master=await f.collect('master',[{id:'c1',name:'A'},{id:'c2',name:'B'}]),org=await f.collect('org',[{id:'c1',parent:'area1',name:'customer node'},{id:'area1',parent:'region1',name:'area'},{id:'region1',parent:'',name:'region'}]);
 const output=await f.d.enrich({datasetRef:master.datasetRef,keyColumn:'id',lookups:[{name:'node',datasetRef:org.datasetRef,sourceColumn:'id',targetColumn:'id',fields:[{column:'parent',as:'area_id'}],missing:'empty'},{name:'area',datasetRef:org.datasetRef,sourceColumn:'area_id',targetColumn:'id',fields:[{column:'name',as:'area'},{column:'parent',as:'region_id'}],missing:'empty'},{name:'region',datasetRef:org.datasetRef,sourceColumn:'region_id',targetColumn:'id',fields:[{column:'name',as:'region'}],missing:'empty'}]});
 assert.equal(output.rowCount,2);assert.equal(output.lookupChecks[0].unmatchedCount,1);assert.equal(output.preview[0].region,'region');assert.equal(output.preview[1].name,'B');assert.equal(output.preview[1].node_status,'未匹配');assert.equal(output.preview[1].region,'');
 const next=new ReportDatasets({maxRows:100,directory:f.root,scope:'env'});assert.equal((await next.inspect({datasetRef:output.datasetRef})).derivation.kind,'left_lookup');
});
test('ambiguous lookup keys, column overwrite and missing required matches are rejected',async t=>{
 const f=await fixture(t),master=await f.collect('master',[{id:'1',name:'a'}]),lookup=await f.collect('duplicate',[{id:'1',name:'x'},{id:'1',name:'y'}]);const args={datasetRef:master.datasetRef,keyColumn:'id',lookups:[{name:'org',datasetRef:lookup.datasetRef,sourceColumn:'id',targetColumn:'id',fields:[{column:'name',as:'org_name'}],missing:'empty'}]};
 await assert.rejects(f.d.enrich(args),/重复/);
 const other=await f.collect('other',[{id:'2',name:'else'}]);args.lookups[0].datasetRef=other.datasetRef;args.lookups[0].missing='error';await assert.rejects(f.d.enrich(args),/未匹配/);
 args.lookups[0].missing='empty';args.lookups[0].fields[0].as='name';await assert.rejects(f.d.enrich(args),/覆盖/);
});
test('enriched six-column reports still pass independent population and numeric reconciliation before delivery',async t=>{
 const {reportFile}=await import('../src/shared/report-files.js');const f=await fixture(t);
 const base=await f.d.collect({sql:'customer amounts',params:[],columns:['id','name','earned','used'],numericColumns:['earned','used']},async()=>[[{id:'1',name:'A',earned:'0.3',used:'0.1'},{id:'2',name:'B',earned:'1',used:'0.2'}]]);
 const org=await f.collect('org',[{id:'1',area:'area',region:'region'}]);
 const enriched=await f.d.enrich({datasetRef:base.datasetRef,keyColumn:'id',lookups:[{name:'org',datasetRef:org.datasetRef,sourceColumn:'id',targetColumn:'id',fields:[{column:'area',as:'area'},{column:'region',as:'region'}],missing:'empty'}]});
 const fields=['name','area','region','earned','used'],draft=await f.d.compose({sources:[{name:'s1',datasetRef:enriched.datasetRef,keyColumn:'id'}],columns:[...fields.map(label=>({label,value:{op:'field',source:'s1',column:label}})),{label:'balance',value:{op:'subtract',args:[{op:'field',source:'s1',column:'earned'},{op:'field',source:'s1',column:'used'}]}}]});
 const baseline=await f.collect('independent grouped totals',[{year:'2026',earned:'1.3',used:'0.3'}]);
 const final=await f.d.finalize({datasetRef:draft.datasetRef,requirement:'all customer six-column balance report',expectedColumns:draft.columns,scopeEvidence:'all active customers for the specified period',populationRef:base.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'source-backed business definition',evidence:'reviewed specification'})),checks:['earned','used'].map(column=>({source:'s1',column,referenceRef:baseline.datasetRef,referenceColumn:column,evidence:'independent full-scope year totals'}))});
 assert.equal(final.coverage.rowCount,2);assert.equal(final.totals.length,2);assert.equal(draft.preview[1][1],'');assert.ok(final.exportFile.verificationHash);
});
test('malformed lookup structures return input errors without crashing the executor',async t=>{
 const f=await fixture(t),base=await f.collect('base',[{id:'1'}]);
 for(const lookups of [[null],[{name:'x',datasetRef:base.datasetRef,sourceColumn:'id',targetColumn:'id',fields:[null],missing:'empty'}]])await assert.rejects(f.d.enrich({datasetRef:base.datasetRef,keyColumn:'id',lookups}),error=>error.code==='REPORT_INPUT');
});

test('explicit fallback lookup uses verified default rows and records inherited matches without replacing specific values',async t=>{
 const f=await fixture(t),master=await f.collect('master',[{id:'a'},{id:'b'},{id:'c'}]),settings=await f.collect('settings',[{id:'a',value:'quarter'},{id:'default',value:'month'}]);
 const args={datasetRef:master.datasetRef,keyColumn:'id',lookups:[{name:'setting',datasetRef:settings.datasetRef,sourceColumn:'id',targetColumn:'id',fields:[{column:'value',as:'effective'}],fallbackKey:'default',missing:'error'}]};
 const r=await f.d.enrich(args);assert.equal(r.lookupChecks[0].fallbackCount,2);assert.equal(r.lookupChecks[0].unmatchedCount,0);assert.deepEqual(r.preview.map(x=>x.effective),['quarter','month','month']);assert.equal(r.preview[1].setting_status,'沿用默认配置');
 args.lookups[0].fallbackKey='nonexistent';await assert.rejects(f.d.enrich(args),/默认/);
});
