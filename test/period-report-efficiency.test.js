import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildPeriodDataset,verifyPeriodDataset} from '../src/shared/period-dataset.js';
import {transformDataset} from '../src/shared/dataset-transform.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {reportPlannerState,fitToolResult} from '../src/runner/environment-investigator.js';
import {inspectReport} from '../src/shared/report-inspection.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';

const data=rows=>({rows,columns:Object.keys(rows[0]),complete:true,readAt:new Date().toISOString(),snapshotId:'snap'});
const period={unit:'month',start:'2025-12',end:'2026-05',column:'month'};
const metrics=[{op:'count',as:'events',cumulativeAs:'totalEvents',missing:'zero',nulls:'error'},
 {op:'count_distinct',column:'object',as:'objects',cumulativeAs:'uniqueObjects',missing:'zero',nulls:'error'},
 {column:'amount',as:'amount',cumulativeAs:'balance',missing:'zero',nulls:'error'}];
const args={populationRef:'p',keyColumns:['owner','warehouse'],period,sources:[{datasetRef:'s',keyColumns:['owner','warehouse'],periodColumn:'day',periodUnit:'day',duplicates:'sum',outside:'exclude',outsideEvidence:'Explicit six-month window only',metrics}]};
const population=data([{owner:'A',warehouse:'W'},{owner:'B',warehouse:'W'}]);
const facts=data([{owner:'A',warehouse:'W',day:20251231,object:'X',amount:'9007199254740993.1'},
 {owner:'A',warehouse:'W',day:'2026-01-02',object:'X',amount:'0.2'},
 {owner:'A',warehouse:'W',day:'2026-01-03',object:'Y',amount:'-0.1'},
 {owner:'A',warehouse:'W',day:'2025-11-30',object:'Z',amount:'100'}]);
const build=(source=facts,a=args)=>buildPeriodDataset(a,ref=>ref==='p'?population:source);

test('one period operation gives exact monthly counts and cumulative distinct unions across year and composite objects',async()=>{
 const d=await build();assert.equal(d.rows.length,12);
 assert.deepEqual(d.rows.slice(0,3).map(r=>[r.events,r.objects,r.uniqueObjects]),[['1','1','1'],['2','2','2'],['0','0','2']]);
 assert.equal(d.rows[1].balance,'9007199254740993.2');assert.ok(d.rows.slice(6).every(r=>r.uniqueObjects==='0'));
 assert.equal(d.derivation.args.periodNormalization,'calendar-v3');assert.equal(d.derivation.audit.sources[0].outsidePeriodRows,1);
 await verifyPeriodDataset(d,ref=>ref==='p'?population:facts);
 d.rows[1].uniqueObjects='3';await assert.rejects(verifyPeriodDataset(d,ref=>ref==='p'?population:facts),/重算/);
});

test('explicit civil date conversion rejects ambiguity and invalid days even outside requested window',async()=>{
 for(const day of ['2025-02-29','2026-13-01','2026-01-01T00:00:00Z',null,'',20260101.1])await assert.rejects(build(data([{...facts.rows[0],day}])),e=>e.code==='REPORT_INPUT');
 await assert.rejects(build(facts,{...args,periodNormalization:'calendar-v2'}),/calendar-v3/);
 await assert.rejects(build(facts,{...args,period:{unit:'day',start:'2025-12-01',end:'2025-12-02',column:'dayKey'},sources:[{...args.sources[0],periodUnit:'month'}]}));
 const leap=await build(data([{...facts.rows[0],day:'2024-02-29'}]),{...args,period:{...period,start:'2024-02',end:'2024-02'}});assert.equal(leap.rows[0].events,'1');
 const custom={...args,period:{unit:'values',column:'phase',values:['phase-2','phase-1']},sources:[]};assert.equal((await build(facts,custom)).rows[0].phase,'phase-2');
});

test('distinct nulls, source duplicates and missing periods keep explicit semantics',async()=>{
 const source=data([{...facts.rows[0],object:null}]);
 await assert.rejects(build(source),/null/);
 const a=structuredClone(args);a.sources[0].metrics[1].nulls='empty';
 assert.equal((await build(source,a)).rows[1].uniqueObjects,null);
 a.sources[0].metrics[1].nulls='zero';assert.equal((await build(source,a)).rows[0].uniqueObjects,'0');
 await assert.rejects(build(facts,{...args,sources:[{...args.sources[0],duplicates:'error'}]}),/重复/);
 await assert.rejects(build(data([{...facts.rows[0],object:{nested:'X'}}])),/去重标识/);
});

test('calendar range filters compare civil days/months without timestamp assumptions, preserving old timestamp behavior',()=>{
 const base=data([{id:'1',d:20240229,m:202601},{id:'2',d:'2024-03-01',m:'2026-2'}]);
 const a={datasetRef:'raw',keyColumn:'id',scopeEvidence:'Explicit civil calendar semantics',filters:[{column:'d',op:'gte',type:'civil_day',value:'2024-02-29'},{column:'m',op:'lt',type:'civil_month',value:'2026-02'}]};
 assert.equal(transformDataset(a,base).rows.length,1);
 assert.throws(()=>transformDataset({...a,filters:[{...a.filters[0],value:'2024-02-30'}]},base),/日期/);
 assert.throws(()=>transformDataset({...a,filters:[{...a.filters[0],type:'date'}]},base),/ISO/);
 assert.throws(()=>transformDataset(a,data([{id:'1',d:'2024-02-30',m:'2026-01'}])),/日期/);
});

async function fixture(t,scope='system-one-test'){
 const root=await mkdtemp(path.join(os.tmpdir(),'period-efficient-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'exports','JOB-e'),d=new ReportDatasets({maxRows:'all',directory,scope});
 const recipes=new Map();
 const save=(name,rows)=>{recipes.set(name,rows);return d.collect({sql:'SELECT '+name,params:[],columns:Object.keys(rows[0]),recipe:{tool:'group_dataset',args:{name}}},async()=>[rows]);};
 const p=await save('independent_population',population.rows),raw=await save('raw_events',facts.rows),ref=await save('independent_events',facts.rows);
 const make=r=>d.period({...args,populationRef:p.datasetRef,sources:r?[{...args.sources[0],datasetRef:r}]:[]});
 const main=await make(raw.datasetRef),baseline=await make(ref.datasetRef),grid=await make();
 const columns=['owner','warehouse','month','events','objects','uniqueObjects','amount','balance'].map(column=>({label:column,value:{op:'field',source:'s1',column}}));
 const out=await d.compose({sources:[{name:'s1',datasetRef:main.datasetRef,keyColumn:'period_key'}],columns});
 const final={datasetRef:out.datasetRef,requirement:'Complete periodic report and distinct union',expectedColumns:out.columns,scopeEvidence:'Independent full population and explicit range',populationRef:grid.datasetRef,populationKey:'period_key',columnRules:out.columns.map(label=>({label,definition:'Explicit period metric and window cumulative',evidence:'Independent raw evidence and documented identity'})),checks:['events','objects','uniqueObjects','amount','balance'].map(column=>({source:'s1',column,referenceRef:baseline.datasetRef,referenceColumn:column,evidence:'Independent raw query and same object-period scope'}))};
 return {root,d,directory,p,raw,main,out,grid,baseline,final,save,recipes};
}

test('new recipes restore, independently finalize, inspect real CSV and centrally refresh with old raw inputs',async t=>{
 const f=await fixture(t);f.d.clear();
 await assert.rejects(f.d.finalize({...f.final,populationRef:f.main.datasetRef}),/sources=\[\]/);
 const i=await f.d.inspect({datasetRef:f.out.datasetRef});assert.equal(i.preview.length,12);assert.equal(i.reportDraft.finalization.populationPlans[0].arguments.sources.length,0);
 await assert.rejects(f.d.finalize({...f.final,checks:f.final.checks.map(c=>({...c,referenceRef:f.main.datasetRef}))}),/同一查询/);
 const out=await f.d.finalize(f.final);const audit=await inspectReport(f.root,{id:'JOB-e',reportFiles:[out.exportFile]},{fileId:out.exportFile.id});assert.equal(audit.status,'verified');assert.equal(audit.calculationAudit.checkedRows,12);
 const refresh=await f.d.refresh(f.final,{begin:async()=>{},reload:async recipe=>f.save(recipe.args.name,f.recipes.get(recipe.args.name))});
 assert.equal(await readFile(path.join(f.directory,out.exportFile.filename),'utf8'),await readFile(path.join(f.directory,refresh.exportFile.filename),'utf8'));
});

test('catalog locates drafts after many derivations, and batch preview pages without per-cell calls',async t=>{
 const f=await fixture(t);for(let n=0;n<23;n++)await f.save('other'+n,[{id:String(n)}]);
 const catalog=await f.d.list();assert.equal(catalog.datasets[0].kind,'report_draft');assert.ok(catalog.datasets[0].createdAt);assert.equal((await f.d.list({kind:'report_draft'})).totalCount,1);
 assert.equal((await f.d.list({columns:['objects']})).totalCount,3);
 let i=await f.d.inspect({datasetRef:f.main.datasetRef,limit:5,columns:['month','objects']});assert.equal(i.preview.length,5);assert.equal(i.nextOffset,5);assert.deepEqual(Object.keys(i.preview[0]),['month','objects']);
 i=await f.d.inspect({datasetRef:f.main.datasetRef,offset:i.nextOffset,limit:100,columns:['month']});assert.equal(i.preview.length,7);assert.equal(i.nextOffset,null);
 const long=await f.save('long',[{id:'one',text:'x'.repeat(9000)}]);assert.equal((await f.d.inspect({datasetRef:long.datasetRef})).previewBlocked,true);assert.equal((await f.d.inspect({datasetRef:long.datasetRef,columns:['id']})).preview.length,1);
 assert.equal((await f.d.readDataset({datasetRef:long.datasetRef,column:'text'})).nextTextOffset,1024);
 const filename=path.join(f.directory,'datasets',f.raw.datasetRef+'.json'),legacy=JSON.parse(await readFile(filename));delete legacy.createdAt;await writeFile(filename,JSON.stringify(legacy));assert.equal((await f.d.list({kind:'query',columns:['_missing']})).totalCount,0);assert.ok((await f.d.list({kind:'query',columns:['day']})).datasets.some(d=>d.createdAt===null));
});

test('two systems and environments compute concurrently; dataset scope cannot cross on resume',async t=>{
 const [a,b]=await Promise.all([fixture(t,'systemA-prd'),fixture(t,'systemB-sit')]);assert.notEqual(a.main.datasetRef,b.main.datasetRef);
 const wrong=new ReportDatasets({maxRows:'all',directory:a.directory,scope:'systemB-sit'});assert.equal((await wrong.list()).totalCount,0);await assert.rejects(wrong.inspect({datasetRef:a.main.datasetRef}),/范围/);
});

test('large inspection metadata is explicitly segmented and can be recovered without a tool-result failure',async t=>{
 const f=await fixture(t);
 const raw=await f.d.captureRows([{id:'one',text:'x'.repeat(5000)}],['id','text'],{complete:true,queryDefinition:{sql:'SELECT '+ 'q'.repeat(6000),params:Array.from({length:45},()=> 'v'.repeat(300))}});
 const overview=await f.d.inspect({datasetRef:raw.datasetRef});assert.ok(overview.omittedSections.includes('preview'));assert.doesNotThrow(()=>fitToolResult(overview));
 const page=await f.d.inspect({datasetRef:raw.datasetRef,sections:['preview']});assert.equal(page.preview[0].text.length,5000);assert.doesNotThrow(()=>fitToolResult(page));
 const query=await f.d.inspect({datasetRef:raw.datasetRef,sections:['queryDefinition']});assert.equal(query.queryDefinition.params.length,45);assert.doesNotThrow(()=>fitToolResult(query));
});

test('planner retains correction and draft beyond recent inspections without carrying business row content',()=>{
 const input=[{tool:'compose_report',result:{datasetRef:'draft',draftFile:{id:'file'},columns:['x'],preview:[{x:'business-private-row'}]}},{tool:'finalize_report',error:{code:'REPORT_INPUT',message:'Need an independent coverage grid'}}];
 for(let n=0;n<30;n++)input.push({tool:'inspect_dataset',result:{datasetRef:'ref'+n,rowCount:6}});
 const s=reportPlannerState(input);assert.equal(s.latestDraft.datasetRef,'draft');assert.equal(s.unresolvedInputs[0].tool,'finalize_report');assert.ok(!JSON.stringify(s).includes('business-private-row'));
});

test('SQL and Mongo tool catalogs expose batch preview and statistical period parameters',async t=>{
 for(const kind of ['mysql','mongodb']){
  const root=await mkdtemp(path.join(os.tmpdir(),'catalog-efficient-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const e={kind,host:'fake',database:'db'},q={tables:['*'],collections:['*'],maxRows:20,exportMaxRows:'all',timeoutMs:1000};
  const tools=await createEnvironmentTools(e,q,{username:'fake',password:'fake'},{exportDirectory:root});t.after(()=>tools.close());
  assert.match(JSON.stringify(tools.spec.find(x=>x.tool==='period_dataset')),/count_distinct/);assert.match(JSON.stringify(tools.spec.find(x=>x.tool==='inspect_dataset')),/nextOffset/);assert.match(JSON.stringify(tools.spec.find(x=>x.tool==='transform_dataset')),/civil_day/);
 }
});
