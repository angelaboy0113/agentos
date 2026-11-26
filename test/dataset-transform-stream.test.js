import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {TaskDatasetStore} from '../src/runner/task-dataset-store.js';
import {transformDataset} from '../src/shared/dataset-transform.js';
import {verifyPeriodDataset} from '../src/shared/period-dataset.js';

const args={keyColumn:'id',scopeEvidence:'complete synthetic cohort',
 json:{column:'payload',records:'array',empty:'keep',statusAs:'status',rowKey:'derived_key',
 fields:[{path:['code'],as:'code',missing:'null',presenceAs:'presence'}]}};
const keepColumns=['derived_key','id','code','presence','status'];
const data={
 columns:['id','payload','amount'],numericColumns:['amount'],complete:true,
 rows:[{id:'001',payload:'[{"code":"00007"},{"code":9007199254740993},{}]',amount:'1.10'},
  {id:'002',payload:null,amount:'2.00'},{id:'003',payload:'[]',amount:null}]
};

async function fixture(t,source=data){
 const directory=await mkdtemp(path.join(os.tmpdir(),'agentos-transform-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new TaskDatasetStore(directory,'scope-a',{chunkThresholdBytes:0,chunkBytes:120});
 const ref='dataset-'+randomUUID(),saved=await store.save(ref,source,'snapshot-a');
 const ds=new ReportDatasets({directory,scope:'scope-a',maxRows:'all'});
 ds.storage=store;
 return {store,ref,ds,base:{...source,readAt:saved.readAt,snapshotId:saved.snapshotId}};
}

test('saved legacy expansion and explicit projection retain exact cells and stable row keys across replay',async t=>{
 const {store,ref,ds,base}=await fixture(t);
 const legacyRef='dataset-'+randomUUID(),legacy=transformDataset({...args,datasetRef:ref},base);
 await store.save(legacyRef,legacy,legacy.snapshotId,legacy.readAt);
 const selected=await ds.transform({datasetRef:legacyRef,keyColumn:'derived_key',scopeEvidence:args.scopeEvidence,keepColumns});
 const directly=await ds.transform({...args,datasetRef:ref,keepColumns});
 const a=await store.get(selected.datasetRef),b=await store.get(directly.datasetRef);
 assert.deepEqual(a.data.rows,b.data.rows);
 assert.deepEqual(b.data.rows.map(r=>[r.id,r.code,r.presence,r.status]),[
  ['001','00007','present','parsed'],['001','9007199254740993','present','parsed'],
  ['001',null,'missing','parsed'],['002',null,'missing','empty'],['003',null,'missing','empty']
 ]);
 assert.deepEqual(b.data.numericColumns,[]);
 assert.equal(b.data.derivation.version,'tree-filter-project-v4');
 assert.equal(b.readAt,base.readAt);
 const opened=await ds.openTransformRows(directly.datasetRef);
 await verifyPeriodDataset(opened.data,()=>assert.fail('must not materialize a transform ancestor'),{
  openRows:ref=>ds.openTransformRows(ref),rowStream:opened.rows
 });
});

test('source key uniqueness is verified even for filtered-out records and other scopes cannot be opened',async t=>{
 const {store,ref,ds}=await fixture(t,{...data,rows:[...data.rows,{...data.rows[1]}]});
 const prior=await readdir(store.root);
 const recipe={datasetRef:ref,keyColumn:'id',scopeEvidence:args.scopeEvidence,keepColumns:['id'],
  filters:[{column:'id',op:'eq',value:'001'}]};
 await assert.rejects(ds.transform(recipe),/唯一/);
 assert.deepEqual(await readdir(store.root),prior);
 await assert.rejects(new TaskDatasetStore(ds.directory,'scope-b').openRows(ref),/范围/);
});

test('bad final digest unwinds previously written output chunks and leaves the original reusable',async t=>{
 const {store,ref,ds}=await fixture(t);
 const file=path.join(store.root,ref+'.json');
 const original=await readFile(file,'utf8'),d=JSON.parse(original),prior=await readdir(store.root);
 d.dataHash='0'.repeat(64);
 await writeFile(file,JSON.stringify(d));
 await assert.rejects(ds.transform({...args,datasetRef:ref}),/完整数据摘要/);
 assert.deepEqual(await readdir(store.root),prior);
 await writeFile(file,original);
 assert.equal((await ds.transform({...args,datasetRef:ref})).rowCount,5);
});
