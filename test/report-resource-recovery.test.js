import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {TaskDatasetStore} from '../src/runner/task-dataset-store.js';
import {reportInvestigationContext} from '../src/runner/environment-job.js';
import {validateToolQuery} from '../src/shared/environment-tool-policy.js';
import {failureDiagnostic} from '../src/shared/failure-diagnostic.js';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'report-resource-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('more than24 small datasets remain reloadable across rounds and cache eviction',async t=>{
 const root=await fixture(t),d=new ReportDatasets({maxRows:10,directory:root,scope:'env',cacheBytes:500});const refs=[];
 for(let i=0;i<30;i++)refs.push((await d.collect({sql:'SELECT '+i,params:[],columns:['id'],numericColumns:[]},async()=>[[{id:String(i)}]])).datasetRef);
 const first=await d.list();assert.equal(first.totalCount,30);assert.equal(first.datasets.length,20);assert.equal((await d.list({offset:first.nextOffset})).datasets.length,10);assert.ok(d.bytes<=500);assert.ok(d.datasets.size<30);
 assert.equal((await d.inspect({datasetRef:refs[0]})).rowCount,1);
 const next=new ReportDatasets({maxRows:10,directory:root,scope:'env',cacheBytes:500});assert.equal((await next.inspect({datasetRef:refs[29]})).rowCount,1);
});
test('actual byte capacity has an explicit safe diagnostic and keeps existing evidence',async t=>{
 const root=await fixture(t),store=new TaskDatasetStore(root,'env',{maxBytes:700}),data={complete:true,columns:['id'],rows:[{id:'x'.repeat(100)}]};
 await store.save('dataset-00000000-0000-0000-0000-000000000001',data,'snap');
 await assert.rejects(store.save('dataset-00000000-0000-0000-0000-000000000002',data,'snap'),e=>e.code==='DATASET_CAPACITY'&&failureDiagnostic(e).includes('DATASET_CAPACITY'));
 assert.equal((await store.list()).length,1);
});
test('specific unresolved correction details survive round boundaries',()=>{
 const context=reportInvestigationContext({originalQuestion:'report',context:[{result:{toolInputErrors:[{tool:'finalize_report',code:'REPORT_INPUT',message:'checks缺少s2:used的独立合计基准',resolved:false}]}}]});
 assert.match(JSON.stringify(context.corrections),/s2:used/);
});
test('trusted report snapshot window configuration is validated',()=>{
 const e={kind:'mysql'},q={mode:'investigate',parameters:[{name:'purpose',type:'string'}],tables:['*'],exportMaxRows:100};
 assert.equal(validateToolQuery(e,{...q,exportSnapshotWindowMs:1200000,exportDataBudgetBytes:64000000}),true);
 for(const v of [0,Number.MAX_SAFE_INTEGER+1,'64000000'])assert.throws(()=>validateToolQuery(e,{...q,exportDataBudgetBytes:v}));
 for(const v of [0,3600001,'1200000'])assert.throws(()=>validateToolQuery(e,{...q,exportSnapshotWindowMs:v}));
});
test('identical complete query reuses one transaction result without extra SQL or saved artifacts',async t=>{
 const root=await fixture(t);let calls=0;const d=new ReportDatasets({maxRows:10,directory:root,scope:'env',reuseQueries:true}),statement={sql:'SELECT id FROM stock',params:['active'],columns:['id']};
 const run=async()=>{calls++;return [[{id:'1'}]];};const a=await d.collect(statement,run),b=await d.collect(statement,run);
 assert.equal(calls,1);assert.equal(a.datasetRef,b.datasetRef);assert.equal(a.readAt,b.readAt);assert.equal(b.reused,true);assert.equal((await d.list()).totalCount,1);
 const other=new ReportDatasets({maxRows:10,directory:root,scope:'env',reuseQueries:true});await other.collect(statement,run);assert.equal(calls,2); // A new transaction never silently reuses old live data.
});
