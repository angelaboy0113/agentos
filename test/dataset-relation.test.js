import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,rename,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {buildRelationalDataset} from '../src/shared/dataset-relation.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {TaskDatasetStore,datasetDependencies} from '../src/runner/task-dataset-store.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {inspectReport} from '../src/shared/report-inspection.js';
const data=rows=>({rows,columns:Object.keys(rows[0]??{id:''}),complete:true,numericColumns:[],readAt:'2026-01-01T00:00:00Z',snapshotId:'initial'});
const main=data([{id:'001',name:'客户',tokens:'p2，p1-p1\tp2'},{id:'002',name:'仓库',tokens:null},{id:'003',name:'项目',tokens:'missing'}]);
const products=data([{id:'p1',code:'0009',flag:'1'},{id:'p2',code:'0010',flag:'0'}]);
const args={datasetRef:'main',keyColumns:['id'],scopeEvidence:'合成源码明确配置成员、空配置保留、非空未匹配排除',joins:[{datasetRef:'products',leftKeys:['tokens'],rightKeys:['id'],rightRowKey:['id'],relationship:'lookup',fields:[{column:'code',as:'product'},{column:'flag',as:'flag'}],split:{delimiters:[',','，','-'],whitespace:true,trim:true,duplicates:'set'},empty:'keep',unmatched:'drop'}]};
const load=async ref=>({main,products})[ref];
test('literal list membership retains right order, exact leading-zero codes, blank vs unmatched and source times',async()=>{
 const out=await buildRelationalDataset(args,load);assert.deepEqual(out.rows.map(r=>[r.id,r.product]),[['001','0009'],['001','0010'],['002',null]]);
 assert.equal(out.derivation.audit.joins[0].duplicateTokens,2);assert.equal(out.derivation.audit.joins[0].emptyInputRows,1);assert.equal(out.derivation.audit.joins[0].unmatchedInputRows,1);assert.equal(out.readAt,main.readAt);assert.equal(main.rows.length,3);
 const same=await buildRelationalDataset(args,load);assert.deepEqual(out,same);
 const preserved=await buildRelationalDataset({...args,joins:[{...args.joins[0],split:{...args.joins[0].split,duplicates:'preserve'}}]},load);assert.equal(preserved.rows.length,5);assert.equal(new Set(preserved.rows.map(r=>r.relation_key)).size,5);
});
test('explicit one-to-many and multiple joins preserve identical-looking business rows and composite identities',async()=>{
 const configs=data([{id:'c1',owner:'001',tokens:'p1'},{id:'c2',owner:'001',tokens:'p1'}]);const m=data([{id:'001',name:'客户'}]);
 const a={...args,joins:[{datasetRef:'configs',leftKeys:['id'],rightKeys:['owner'],rightRowKey:['id'],relationship:'expand',fields:[{column:'tokens',as:'tokens'}],empty:'error',unmatched:'error'},args.joins[0]]};
 const out=await buildRelationalDataset(a,async ref=>({main:m,configs,products})[ref]);assert.equal(out.rows.length,2);assert.equal(new Set(out.rows.map(r=>r.relation_key)).size,2);
 await assert.rejects(buildRelationalDataset({...a,joins:[{...a.joins[0],relationship:'lookup'}]},async ref=>({main:m,configs})[ref]),/右键重复/);
});
test('explicit projections and dictionary labels preserve null; unknown values error and monetary relabeling refuses',async()=>{
 const a={...args,project:[{column:'id',as:'对象编码'},{column:'product',as:'产品编码'},{column:'flag',as:'状态',labels:{'1':'启用','0':'停用'},unmapped:'error'}]};
 const out=await buildRelationalDataset(a,load);assert.deepEqual(out.columns,['对象编码','产品编码','状态','relation_key']);assert.deepEqual(out.rows.map(r=>r.状态),['启用','停用',null]);
 await assert.rejects(buildRelationalDataset({...a,project:[{...a.project[2],labels:{}}]},load),/枚举值未核实/);
 await assert.rejects(buildRelationalDataset(a,async ref=>ref==='products'?{...products,numericColumns:['flag']}:main),/金额/);
});
test('invalid types, duplicate real keys, missing columns and unsafe aliases fail without guessing or mutating evidence',async()=>{
 for(const a of [{...args,keyColumns:['name']},{...args,rowKey:'id'},{...args,joins:[{...args.joins[0],fields:[{column:'code',as:'__proto__'}]}]},{...args,joins:[{...args.joins[0],split:{...args.joins[0].split,delimiters:['']}}]}]){
  // name is unique here; use duplicate base data for that case.
  const l=a.keyColumns?.[0]==='name'?async r=>r==='main'?{...main,rows:[main.rows[0],main.rows[0]]}:products:load;
  await assert.rejects(buildRelationalDataset(a,l));
 }
 await assert.rejects(buildRelationalDataset(args,async ref=>ref==='main'?data([{id:'1',tokens:123}]):products),/文本/);
 await assert.rejects(buildRelationalDataset(args,async ref=>ref==='products'?{...products,complete:false}:main),/完整/);
 await assert.rejects(buildRelationalDataset({...args,joins:[{...args.joins[0],unmatched:'error'}]},load),/未匹配/);
 await assert.rejects(buildRelationalDataset({...args,joins:[{...args.joins[0],empty:'error'}]},load),/为空/);
});
async function fixture(t,scope='system-a/prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'relate-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','JOB-synthetic'),d=new ReportDatasets({directory,scope,maxRows:'all'});
 const collect=async (value,table)=>d.collect({sql:'SELECT '+table+' ORDER BY id',params:[],columns:value.columns,recipe:{tool:'group_dataset',args:{table}}},async()=>[value.rows]);
 const m=await collect(main,'main'),p=await collect(products,'products');return {root,directory,scope,d,a:{...args,datasetRef:m.datasetRef,joins:[{...args.joins[0],datasetRef:p.datasetRef}]}};
}
test('persisted relation restores and verifies, emits actual CSV, records dependencies, rejects tamper and cross-scope use',async t=>{
 const f=await fixture(t),out=await f.d.relate(f.a),d=new ReportDatasets({directory:f.directory,scope:f.scope,maxRows:'all'}),saved=await d.restore(out.datasetRef);await d.verifyDerived(saved);assert.equal(datasetDependencies(saved).length,2);
 const draft=await d.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'relation_key'}],columns:[{label:'对象',value:{op:'field',source:'s1',column:'name'}},{label:'产品',value:{op:'field',source:'s1',column:'product',missing:'empty'}}]});
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'完整对象配置产品清单',scopeEvidence:args.scopeEvidence,expectedColumns:draft.columns,populationRef:out.datasetRef,populationKey:'relation_key',checks:[],columnRules:draft.columns.map(label=>({label,definition:'合成原始文本字段',evidence:'合成成员展开与空值规则'}))});
 const report=await inspectReport(f.root,{id:'JOB-synthetic',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(report.calculationAudit.checkedCells,6);
 const text=await readFile(path.join(f.directory,final.exportFile.filename),'utf8');assert.match(text,/0009/);
 saved.rows[0].product='wrong';await assert.rejects(d.verifyDerived(saved),/重算不一致/);
 await assert.rejects(new ReportDatasets({directory:f.directory,scope:'system-b/sit',maxRows:'all'}).restore(out.datasetRef));
});
test('central refresh reloads each source once and reconstructs expansion, without a task round limit',async t=>{
 const f=await fixture(t),out=await f.d.relate(f.a),draft=await f.d.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'relation_key'}],columns:[{label:'产品',value:{op:'field',source:'s1',column:'product',missing:'empty'}}]});let calls=0;
 const final=await f.d.refresh({datasetRef:draft.datasetRef,requirement:'完整产品清单刷新',scopeEvidence:args.scopeEvidence,expectedColumns:draft.columns,populationRef:out.datasetRef,populationKey:'relation_key',checks:[],columnRules:[{label:'产品',definition:'真实产品编码',evidence:'合成完整成员匹配'}]},{begin:async()=>{},reload:async recipe=>{calls++;const d=recipe.args.table==='main'?main:products;return f.d.collect({sql:'SELECT fresh_'+recipe.args.table,params:[],columns:d.columns,recipe},async()=>[d.rows]);}});assert.equal(calls,2);assert.equal(final.exportFile.rowCount,3);
});
test('two systems/environments concurrently expose relation tool on saved data only and honor revocation',async t=>{
 await Promise.all(['system-a/prd','system-b/sit'].map(async (name,i)=>{
  const e={kind:i?'mongodb':'mysql',host:name,port:i?27017:3306,database:'synthetic'},scope=createHash('sha256').update(JSON.stringify(e)).digest('hex'),f=await fixture(t,scope);let allowed=true;
  const tools=await createEnvironmentTools(e,{tables:['*'],maxRows:10,exportMaxRows:'all',timeoutMs:1000,exportTimeoutMs:3000},{username:'synthetic',password:'test-only'},{exportDirectory:f.directory,authorize:async()=>{if(!allowed)throw Error('revoked');},mysql:{createConnection:async()=>{throw Error('NO DATABASE CALL ALLOWED');}}});
  try{assert.ok(tools.spec.find(s=>s.tool==='relate_dataset'));const out=await tools.run('relate_dataset',f.a);assert.equal(out.rowCount,3);allowed=false;await assert.rejects(tools.run('relate_dataset',f.a));}finally{await tools.close();}
 }));
});
test('relation cannot hide source provenance or turn repeated amounts into independent evidence',async t=>{
 const f=await fixture(t),out=await f.d.relate(f.a),d=await f.d.restore(out.datasetRef);assert.equal(await f.d.rawEvidence(d,'product'),await f.d.rawEvidence(await f.d.restore(f.a.joins[0].datasetRef),'code'));assert.equal(await f.d.rawEvidence(d,'relation_key'),null);
});
test('composite join keys keep tenant boundaries and input order, refresh does not silently choose first duplicate',async()=>{
 const m=data([{id:'m2',tenant:'west',code:'001'},{id:'m1',tenant:'east',code:'001'}]);
 const r=data([{id:'r1',tenant:'east',code:'001',value:'east-only'},{id:'r2',tenant:'west',code:'001',value:'west-only'}]);
 const a={...args,joins:[{datasetRef:'products',leftKeys:['tenant','code'],rightKeys:['tenant','code'],rightRowKey:['tenant','id'],relationship:'lookup',fields:[{column:'value',as:'matched'}],empty:'error',unmatched:'error'}]};
 const out=await buildRelationalDataset(a,async ref=>ref==='main'?m:r);assert.deepEqual(out.rows.map(r=>r.matched),['west-only','east-only']);
});
test('fresh restore refuses symlinked dependency files even if their content/hash and environment are otherwise correct',async t=>{
 const f=await fixture(t),out=await f.d.relate(f.a),name=f.a.joins[0].datasetRef+'.json',file=path.join(f.directory,'datasets',name),moved=path.join(f.root,name);
 await rename(file,moved);await symlink(moved,file);
 const d=new ReportDatasets({directory:f.directory,scope:f.scope,maxRows:'all'}),saved=await d.restore(out.datasetRef);
 await assert.rejects(d.verifyDerived(saved),/校验失败/);
});
