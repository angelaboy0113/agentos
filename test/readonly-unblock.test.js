import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {percentage,summarizeDataset} from '../src/shared/dataset-summary.js';
import {TaskDatasetStore} from '../src/runner/task-dataset-store.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {queryTimeout,fingerprint} from '../src/shared/environment-access.js';
import {assessReportDelivery} from '../src/shared/report-acceptance.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
test('saved population value sets retain more than a thousand keys without a database read',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'cohort-'));t.after(()=>rm(directory,{recursive:true,force:true}));const e={kind:'mysql',projectId:'demo',tier:'prd'},ref='dataset-22222222-2222-2222-2222-222222222222';
 await new TaskDatasetStore(directory,fingerprint(e)).save(ref,{rows:Array.from({length:3198},(_,id)=>({id:String(id)})),columns:['id'],complete:true,numericColumns:[],readAt:new Date().toISOString()},'cohort');
 const tools=await createEnvironmentTools(e,{exportMaxRows:'all',maxRows:5,timeoutMs:1000},{},{exportDirectory:directory,connect:()=>{throw new Error('must not query');}});
 const result=await tools.run('collect_dataset_values',{datasetRef:ref,columns:['id'],nulls:'error'});assert.equal(result.count,3198);assert.equal(result.truncated,false);assert.equal(result.sample.length,5);await tools.close();
});
const base={rows:[{id:'1',owner:'a',value:'9007199254740993.12'},{id:'2',owner:'a',value:'0.01'},{id:'3',owner:'b',value:null}],columns:['id','owner','value'],numericColumns:['value'],complete:true,readAt:new Date().toISOString(),snapshotId:'first'};
test('local grouping preserves exact sums, null semantics and stable group grain; percentages are exact',()=>{
 const args={datasetRef:'original',groupColumns:['owner'],aggregates:[{op:'count_distinct',column:'id',as:'n'},{op:'sum',column:'value',as:'sum',nulls:'empty'}]};const out=summarizeDataset(args,base);assert.equal(out.rows[0].sum,'9007199254740993.13');assert.equal(out.rows[1].sum,null);assert.equal(out.rows[0].n,'2');assert.equal(percentage('1','3',{precision:2,zeroDenominator:'error'}),'33.33%');assert.equal(percentage('1','0',{zeroDenominator:'empty'}),'');assert.throws(()=>percentage('1','0',{zeroDenominator:'error'}));
});
test('explicit dataset scopes can combine only authorized local sources, retaining task and environment boundaries',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scopes-'));t.after(()=>rm(root,{recursive:true,force:true}));const id='dataset-11111111-1111-1111-1111-111111111111';
 await new TaskDatasetStore(root,'ltx/prd/staff').save(id,base,'first');
 await assert.rejects(new TaskDatasetStore(root,'ltx/prd/visit').get(id));
 assert.equal((await new TaskDatasetStore(root,'ltx/prd/visit',{additionalScopes:['ltx/prd/staff']}).get(id)).data.rows.length,3);
 await assert.rejects(new TaskDatasetStore(root,'tpm/uat/staff',{additionalScopes:['tpm/uat/visit']}).get(id));await assert.rejects(new TaskDatasetStore(root+'/another-job','ltx/prd/staff').get(id));
 const d=new ReportDatasets({directory:root,scope:'ltx/prd/visit',datasetScopes:['ltx/prd/staff'],maxRows:'all'});const out=await d.summarize({datasetRef:id,groupColumns:['owner'],aggregates:[{op:'count_distinct',column:'id',as:'n'}]});const restored=await d.restore(out.datasetRef);await d.verifyDerived(restored);restored.rows[0].n='99';await assert.rejects(d.verifyDerived(restored));
});
test('operator query latency policy does not rewrite source identity and never permits false file completion',()=>{
 const e={kind:'mysql'},q={mode:'investigate',timeoutMs:10000},config={executionPolicy:{mysqlQueryTimeoutMs:120000}},before=fingerprint(e);assert.equal(queryTimeout(config,e,q),120000);assert.equal(fingerprint(e),before);assert.equal(queryTimeout(config,{kind:'website'},q),10000);
 const result=assessReportDelivery({tabularDelivery:true,taskIntent:'analysis',reportFiles:[]},{outcome:'ready',investigation:{status:'complete'}});assert.equal(result.outcome,'partial');assert.equal(result.investigation.status,'continue');
});
test('percentage file content is independently recomputed and cannot finalize without independent count proofs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ratio-'));t.after(()=>rm(root,{recursive:true,force:true}));const dir=path.join(root,'exports','JOB-ratio'),d=new ReportDatasets({maxRows:'all',directory:dir,scope:'scope'});
 const get=(sql,rows,columns,numericColumns=[])=>d.collect({sql,params:[],columns,numericColumns},async()=>[rows]);
 const pop=await get('SELECT object ids',[{id:'a'}],['id']);const data=await get('SELECT source counts',[{id:'a',n:'1',d:'3'}],['id','n','d'],['n','d']);const ref=await get('SELECT independent counts',[{id:'a',n:'1',d:'3'}],['id','n','d'],['n','d']);
 const report=await d.compose({sources:[{name:'s1',datasetRef:data.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'覆盖率',value:{op:'percentage',precision:2,zeroDenominator:'empty',args:[{op:'field',source:'s1',column:'n'},{op:'field',source:'s1',column:'d'}]}}]});
 const args={datasetRef:report.datasetRef,requirement:'独立核验覆盖率',scopeEvidence:'完整对象与独立计数依据',expectedColumns:report.columns,populationRef:pop.datasetRef,populationKey:'id',columnRules:report.columns.map(label=>({label,definition:'明确计数或占比定义',evidence:'合成独立查询口径'})),checks:[]};await assert.rejects(d.finalize(args),/基准/);
 const final=await d.finalize({...args,checks:['n','d'].map(column=>({source:'s1',column,referenceRef:ref.datasetRef,referenceColumn:column,evidence:'独立SQL相同对象和状态计数'}))});const {inspectReport}=await import('../src/shared/report-inspection.js');const proof=await inspectReport(root,{id:'JOB-ratio',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(proof.calculationAudit.status,'passed');assert.equal(report.preview[0][1],'33.33%');
});
