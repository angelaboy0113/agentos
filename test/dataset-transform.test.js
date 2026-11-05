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
import {exactText} from '../src/shared/dataset-transform.js';
test('explicit text conversion preserves raw columns and rejects lossy or ignored requests',()=>{
 const b={rows:[{id:'a',value:9300000000},{id:'b',value:'00093'},{id:'c',value:null},{id:'d',value:'900719925474099312345'}],columns:['id','value'],complete:true};const a={keyColumn:'id',scopeEvidence:'complete original identifiers',conversions:[{column:'value',as:'text',type:'string'}]};const out=transformDataset(a,b);assert.deepEqual(out.rows.map(r=>r.text),['9300000000','00093',null,'900719925474099312345']);assert.equal(out.rows[0].value,9300000000);assert.equal(b.rows[0].text,undefined);assert.equal(out.derivation.version,'tree-filter-text-v2');
 for(const v of [1.2,Number.MAX_SAFE_INTEGER+1,{},undefined])assert.throws(()=>exactText(v),e=>e.code==='REPORT_INPUT');for(const v of ['1e3','1.0','',false])assert.throws(()=>exactText(v,'integer_decimal'));
 assert.equal(exactText('00093','integer_decimal'),'93');assert.throws(()=>transformDataset({...a,casts:[]},b),/未支持/);assert.throws(()=>transformDataset({...a,conversions:[{column:'value',as:'value',type:'string'}]},b));
});
test('cast recipe survives cold restore, verifies actual joined CSV, and cannot hide normalized duplicate keys',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cast-report-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','cast'),scope='system-a/prd',d=new ReportDatasets({maxRows:'all',directory,scope});
 const input=await d.importInput({rows:[{row:'1',id:93},{row:'2',id:'00094'}],columns:['row','id'],complete:true,inputEvidence:{version:1,kind:'native-cloud-sheet',rowCount:2,rowKey:'row',columns:[{index:0,as:'id'}]},readAt:new Date().toISOString()});
 const cast=await d.transform({datasetRef:input.datasetRef,keyColumn:'row',scopeEvidence:'original full input',conversions:[{column:'id',as:'id_text',type:'string'}]});const other=await d.collect({sql:'SELECT fixture ORDER BY id',params:[],columns:['id','state']},async()=>[[{id:'93',state:'pending'},{id:'00094',state:'complete'}]]);
 const restored=new ReportDatasets({maxRows:'all',directory,scope});await restored.verifyDerived(await restored.restore(cast.datasetRef));
 const linked=await restored.enrich({datasetRef:cast.datasetRef,keyColumn:'row',lookups:[{name:'records',datasetRef:other.datasetRef,sourceColumn:'id_text',targetColumn:'id',missing:'error',fields:[{column:'state',as:'state'}]}]});const draft=await restored.compose({sources:[{name:'s1',datasetRef:linked.datasetRef,keyColumn:'row'}],columns:[{label:'编号',value:{op:'field',source:'s1',column:'id_text'}},{label:'状态',value:{op:'field',source:'s1',column:'state'}}]});
 const final=await restored.finalize({datasetRef:draft.datasetRef,requirement:'full identifier state list',expectedColumns:draft.columns,scopeEvidence:'complete original source',populationRef:input.datasetRef,populationKey:'row',columnRules:draft.columns.map(label=>({label,definition:'exact source field',evidence:'complete input and saved records'})),checks:[]});const f=await reportFile(root,'cast',final.exportFile);assert.match(f.content.toString(),/"00094","complete"/);assert.match(f.content.toString(),/"93","pending"/);
 const tampered=await restored.restore(cast.datasetRef);tampered.rows[0].id_text='wrong';await assert.rejects(restored.verifyDerived(tampered),/重算不一致/);
 const duplicate=transformDataset({keyColumn:'row',scopeEvidence:'explicit integer matching',conversions:[{column:'id',as:'normalized',type:'string',normalization:'integer_decimal'}]},{rows:[{row:'1',id:'093'},{row:'2',id:93}],columns:['row','id'],complete:true});assert.equal(duplicate.rows.length,2);assert.equal(duplicate.rows[0].normalized,duplicate.rows[1].normalized);
});
import {parseExactJson} from '../src/shared/exact-json.js';
test('JSON data parsing preserves numeric lexemes, rejects duplicate keys and never executes content',()=>{
 assert.deepEqual(parseExactJson('{"n":900719925474099312345,"price":12.300,"exp":1e4,"name":"001","null":null,"bool":true}'),{n:'900719925474099312345',price:'12.300',exp:'1e4',name:'001',null:null,bool:true});
 for(const s of ['{"a":1,"a":2}','[1,]','{"n":01}','NaN','undefined','{"n":1} garbage','{"x":"\\q"}'])assert.throws(()=>parseExactJson(s),e=>e.code==='REPORT_INPUT');assert.equal(Object.hasOwn(parseExactJson('{"__proto__":{"polluted":true}}'),'__proto__'),true);assert.equal({}.polluted,undefined);
});
test('saved JSON arrays expand explicitly with stable row keys, missing/null distinction and exact filtering',()=>{
 const a={keyColumn:'id',scopeEvidence:'complete saved change log',json:{column:'payload',records:'array',empty:'keep',rowKey:'json_row',fields:[{path:['nested','code'],as:'code',missing:'null',presenceAs:'code_presence'},{path:['amount'],as:'amount',missing:'null'}]}};
 const b={rows:[{id:'a',payload:'[{"nested":{"code":"001"},"amount":900719925474099312345},{"nested":{"code":null},"amount":12.30},{"other":1}]'},{id:'b',payload:'[]'}],columns:['id','payload'],complete:true};const out=transformDataset(a,b);assert.equal(out.rows.length,4);assert.deepEqual(out.rows.map(r=>r.code_presence),['present','present','missing','missing']);assert.equal(out.rows[0].amount,'900719925474099312345');assert.equal(out.rows[1].amount,'12.30');assert.equal(new Set(out.rows.map(r=>r.json_row)).size,4);assert.equal(b.rows.length,2);
 const filtered=transformDataset({keyColumn:'json_row',scopeEvidence:'explicit exact code',filters:[{column:'code',op:'eq',value:'001'}]},out);assert.equal(filtered.rows.length,1);
 for(const payload of ['{"not":"array"}','[null]','[{"amount":{}}]','bad'])assert.throws(()=>transformDataset(a,{...b,rows:[{id:'x',payload}]}));assert.throws(()=>transformDataset({...a,json:{...a.json,fields:[{path:['__proto__'],as:'bad',missing:'null'}]}},b));assert.throws(()=>transformDataset({...a,json:{...a.json,fields:[{path:['missing'],as:'missing',missing:'error'}]}},b));
});
test('JSON transforms cold restore and replay from their original fixed data',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'json-transform-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','job'),scope='system-b/sit',d=new ReportDatasets({maxRows:'all',directory,scope}),raw=await d.collect({sql:'SELECT id,payload FROM fixture ORDER BY id',params:[],columns:['id','payload']},async()=>[[{id:'a',payload:'[{"code":"0001"},{"code":"0001"}]'}]]),converted=await d.transform({datasetRef:raw.datasetRef,keyColumn:'id',scopeEvidence:'saved original log',json:{column:'payload',records:'array',empty:'error',rowKey:'json_row',fields:[{path:['code'],as:'code',missing:'error'}]}});const next=new ReportDatasets({maxRows:'all',directory,scope});const data=await next.restore(converted.datasetRef);await next.verifyDerived(data);assert.equal(data.rows.length,2);assert.equal(data.rows[0].code,data.rows[1].code);data.rows[0].code='wrong';await assert.rejects(next.verifyDerived(data),/重算不一致/);await assert.rejects(new ReportDatasets({maxRows:'all',directory,scope:'foreign/prd'}).restore(converted.datasetRef));
});
test('invalid and duplicate-key logs can only be kept with explicit visible parse status, never fake null/zero evidence',()=>{
 const b={columns:['id','payload'],rows:[{id:'a',payload:'[{"n":1,"n":2}]'},{id:'b',payload:'broken'},{id:'c',payload:'[{"n":null}]'}],complete:true};const a={keyColumn:'id',scopeEvidence:'full saved log scope',json:{column:'payload',records:'array',empty:'keep',invalid:'keep',statusAs:'parse_state',rowKey:'json_row',fields:[{path:['n'],as:'n',missing:'error'}]}};const out=transformDataset(a,b);assert.deepEqual(out.rows.map(r=>r.parse_state),['duplicate_json_key','invalid_json','parsed']);assert.equal(out.derivation.audit.jsonInvalidRows,2);assert.equal(out.derivation.audit.jsonDuplicateKeyRows,1);assert.deepEqual(out.rows.map(r=>r.payload),b.rows.map(r=>r.payload));assert.throws(()=>transformDataset({...a,json:{...a.json,statusAs:undefined}},b));
});
