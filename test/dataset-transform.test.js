import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {transformDataset} from '../src/shared/dataset-transform.js';
import {createHash} from 'node:crypto';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {reportFile} from '../src/shared/report-files.js';
const base=(rows)=>({rows,columns:['id','parent','name','kind','code'],numericColumns:[],complete:true,readAt:new Date().toISOString(),snapshotId:'original'});
const rows=[{id:'r',parent:'outside',name:'Root',kind:'root',code:null},{id:'a',parent:'r',name:'Area',kind:'area',code:'035'},{id:'b',parent:'a',name:'Office',kind:'office',code:null},{id:'x',parent:null,name:'Other',kind:'area',code:'999'}];
const args={datasetRef:'unused',keyColumn:'id',scopeEvidence:'Synthetic complete hierarchy',filters:[],hierarchy:{parentColumn:'parent',rootIds:['r'],includeRoots:false,pathColumns:[{column:'name',as:'path'}],separator:' / '}};
test('hierarchy supports multiple domains, arbitrary depth, precise codes, nulls and post-traversal filters',()=>{
 for(const domain of ['customer','warehouse']){const data=base(rows.map(r=>({...r,name:domain+r.name})));const out=transformDataset({...args,filters:[{column:'kind',op:'in',values:['office']}]},data);assert.equal(out.rows.length,1);assert.equal(out.rows[0].code,null);assert.equal(out.rows[0].path,`${domain}Root / ${domain}Area / ${domain}Office`);assert.equal(out.readAt,data.readAt);assert.equal(data.rows.length,4);}
 const chain=Array.from({length:180},(_,i)=>({id:String(i),parent:i?String(i-1):null,name:String(i),kind:'n',code:'001'}));assert.equal(transformDataset({...args,hierarchy:{...args.hierarchy,rootIds:['0']}},base(chain)).rows.length,179);
 const blocked=transformDataset({...args,hierarchy:{...args.hierarchy,nodeFilters:[{column:'kind',op:'ne',value:'area'}]}},base(rows));assert.equal(blocked.rows.length,0);
 assert.equal(transformDataset({...args,hierarchy:undefined,filters:[{column:'code',op:'is_null'}]},base(rows)).rows.length,2);
});
test('missing roots, duplicates, cycles, overlapping roots, incomplete data and invalid fields fail explicitly',()=>{
 for(const data of [base([...rows,rows[0]]),base(rows.map(r=>({...r,parent:r.id==='r'?'b':r.parent}))),{...base(rows),complete:false}])assert.throws(()=>transformDataset(args,data));
 assert.throws(()=>transformDataset({...args,hierarchy:{...args.hierarchy,rootIds:['missing']}},base(rows)));
 assert.throws(()=>transformDataset({...args,hierarchy:{...args.hierarchy,rootIds:['r','a']}},base(rows)));
 assert.throws(()=>transformDataset({...args,filters:[{column:'code',op:'eval',value:'x'}]},base(rows)));
 assert.throws(()=>transformDataset({...args,hierarchy:{...args.hierarchy,pathColumns:[{column:'code',as:'path'}]}},base(rows)),/为空/);
});
async function setup(t,scope='system-a/prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'transform-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','JOB-fixture');
 const d=new ReportDatasets({maxRows:'all',directory,scope});const b=base(rows);
 const raw=await d.collect({sql:'SELECT complete FROM fixture ORDER BY id',params:[],columns:b.columns,recipe:{tool:'group_dataset',args:{table:'fixture'}}},async()=>[rows]);
 return {d,directory,raw,scope};
}
test('durable transformation, exact file verification and task/environment isolation require no new query',async t=>{
 const {d,directory,raw,scope}=await setup(t);const out=await d.transform({...args,datasetRef:raw.datasetRef});
 const next=new ReportDatasets({maxRows:'all',directory,scope});const data=await next.restore(out.datasetRef);assert.equal(data.rows[0].code,'035');await next.verifyDerived(data);
 const foreign=new ReportDatasets({maxRows:'all',directory,scope:'system-b/sit'});await assert.rejects(foreign.restore(out.datasetRef));
 const draft=await next.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'id'}],columns:[{label:'编码',value:{op:'field',source:'s1',column:'code',missing:'empty'}},{label:'完整路径',value:{op:'field',source:'s1',column:'path'}}]});
 const final=await next.finalize({datasetRef:draft.datasetRef,requirement:'完整组织编码及路径',expectedColumns:draft.columns,scopeEvidence:'Synthetic root descendants verified',populationRef:out.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'完整来源字段及路径',evidence:'合成树父子关系定义'})),checks:[]});
 const f=await reportFile(path.dirname(path.dirname(directory)),path.basename(directory),final.exportFile);assert.match(f.content.toString(),/035/);assert.match(f.content.toString(),/Root \/ Area \/ Office/);
 const tampered=await next.restore(out.datasetRef);tampered.rows[0].path='wrong';await assert.rejects(next.verifyDerived(tampered),/重算不一致/);
});
test('central refresh replays raw source once and rebuilds selection and paths',async t=>{
 const {d,raw}=await setup(t);const out=await d.transform({...args,datasetRef:raw.datasetRef});const draft=await d.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'id'}],columns:[{label:'名称',value:{op:'field',source:'s1',column:'name'}}]});let count=0;
 const f=await d.refresh({datasetRef:draft.datasetRef,requirement:'完整名称清单',expectedColumns:draft.columns,scopeEvidence:'完整合成后代范围',populationRef:out.datasetRef,populationKey:'id',columnRules:[{label:'名称',definition:'来源名称原值',evidence:'合成节点名称定义'}],checks:[]},{begin:async()=>{},reload:async()=>{count++;return d.collect({sql:'SELECT fresh ORDER BY id',params:[],columns:base(rows).columns},async()=>[rows]);}});assert.equal(count,1);assert.ok(f.exportFile);
});

test('runtime exposes transform to both system environments and runs only on persisted data without DB',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'transform-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await Promise.all(['system-a/prd','system-b/sit'].map(async system=>{
  const e={kind:'mysql',host:system,port:3306,database:'fixture'},scope=createHash('sha256').update(JSON.stringify(e)).digest('hex'),directory=path.join(root,system);
  const d=new ReportDatasets({maxRows:'all',directory,scope});const raw=await d.collect({sql:'SELECT fixture',params:[],columns:base(rows).columns},async()=>[rows]);
  let allowed=true;const tools=await createEnvironmentTools(e,{tables:['*'],maxRows:10,exportMaxRows:'all',timeoutMs:1000,exportTimeoutMs:3000},{username:'fake',password:'secret-fixture'},{exportDirectory:directory,authorize:async()=>{if(!allowed)throw Error('revoked');},mysql:{createConnection:async()=>{throw Error('DB MUST NOT BE OPENED');}}});
  try{assert.ok(tools.spec.some(t=>t.tool==='transform_dataset'));const result=await tools.run('transform_dataset',{...args,datasetRef:raw.datasetRef});assert.equal(result.rowCount,2);allowed=false;await assert.rejects(tools.run('transform_dataset',{...args,datasetRef:raw.datasetRef}));}finally{await tools.close();}
 }));
});
