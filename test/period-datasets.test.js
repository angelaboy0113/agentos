import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildPeriodDataset,periodValues,verifyPeriodDataset} from '../src/shared/period-dataset.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {inspectReport} from '../src/shared/report-inspection.js';
const pages=rows=>async({sql})=>{const m=sql.match(/LIMIT (\d+) OFFSET (\d+)$/);return [rows.slice(+m[2],+m[2]+ +m[1])];};
const period={unit:'month',start:'2025-12',end:'2026-02',column:'month'};
const metric={column:'amount',as:'current',cumulativeAs:'running',missing:'zero',nulls:'empty'};
const data=rows=>({rows,columns:Object.keys(rows[0]??{id:''}),complete:true,readAt:'2026-10-26T00:00:00Z',snapshotId:'snapshot'});
const args={populationRef:'p',keyColumns:['id'],period,sources:[{datasetRef:'s',keyColumns:['id'],periodColumn:'period',duplicates:'sum',outside:'error',metrics:[metric]}]};
const build=(p,s,a=args)=>buildPeriodDataset(a,ref=>ref==='p'?data(p):data(s));
test('calendar ranges preserve chronological cross-year, leap day and custom ordering',()=>{
 assert.deepEqual(periodValues(period),['2025-12','2026-01','2026-02']);
 assert.deepEqual(periodValues({unit:'day',start:'2024-02-28',end:'2024-03-01',column:'date'}),['2024-02-28','2024-02-29','2024-03-01']);
 assert.deepEqual(periodValues({unit:'values',values:['FY-Q4','FY-Q1'],column:'quarter'}),['FY-Q4','FY-Q1']);
 for(const p of [{...period,start:'2026-13'},{...period,start:'2027-01'},{unit:'day',start:'2025-02-29',end:'2025-03-01',column:'date'},{unit:'values',values:['x','x'],column:'q'}])assert.throws(()=>periodValues(p));
});
test('sparse periods, exact decimals, negative movement, unknowns and objects with no activity',async()=>{
 const d=await build([{id:'001'},{id:'002'}],[{id:'001',period:'2025-12',amount:'9007199254740993.12'},{id:'001',period:'2025-12',amount:'0.01'},{id:'001',period:'2026-02',amount:'-0.03'}]);
 assert.equal(d.rows.length,6);assert.deepEqual(d.rows.slice(0,3).map(r=>[r.current,r.running]),[['9007199254740993.13','9007199254740993.13'],['0','9007199254740993.13'],['-0.03','9007199254740993.1']]);assert.ok(d.rows.slice(3).every(r=>r.running==='0'));assert.equal(d.derivation.audit.sources[0].duplicateRows,1);
 const unknown=await build([{id:'1'}],[{id:'1',period:'2025-12',amount:null},{id:'1',period:'2026-02',amount:'2'}]);assert.deepEqual(unknown.rows.map(r=>r.running),[null,null,null]);assert.equal(unknown.rows[2].current,'2');
 await assert.rejects(build([{id:'1'}],[{id:'1',period:'2025-12',amount:null},{id:'1',period:'2025-12',amount:'not-a-number'}]),/十进制/);
});
test('duplicate population and ambiguous source rows fail; exclusions require evidence and are audited',async()=>{
 await assert.rejects(build([{id:'1'},{id:'1'}],[]),/重复/);
 const rows=[{id:'1',period:'2025-12',amount:'1'},{id:'1',period:'2025-12',amount:'2'}];
 await assert.rejects(build([{id:'1'}],rows,{...args,sources:[{...args.sources[0],duplicates:'error'}]}),/重复/);
 await assert.rejects(build([{id:'1'}],[{id:'other',period:'2025-12',amount:'2'}]),/范围外/);
 const d=await build([{id:'1'}],[{id:'other',period:'2025-12',amount:'2'}],{...args,sources:[{...args.sources[0],outside:'exclude',outsideEvidence:'仅有效主对象'}]});assert.equal(d.derivation.audit.sources[0].outsideRows,1);
});
test('4873 objects expand into 58476 monthly rows, retaining zero months and exact totals',async()=>{
 const population=Array.from({length:4873},(_,i)=>({id:String(i).padStart(8,'0')}));const p={unit:'month',start:'2026-01',end:'2026-12',column:'month'};
 const d=await build(population,[{id:'00000000',period:'2026-11',amount:'0.1'},{id:'00000000',period:'2026-12',amount:'0.2'}],{...args,period:p});
 assert.equal(d.rows.length,58476);assert.equal(new Set(d.rows.map(r=>r.period_key)).size,58476);assert.equal(d.rows[11].running,'0.3');assert.equal(d.rows.at(-1).running,'0');
});
test('composite keys, separate year/month, empty datasets, cancellation and tampering',async()=>{
 const a={populationRef:'p',keyColumns:['id','warehouse'],period,sources:[{...args.sources[0],keyColumns:['id','warehouse'],periodColumn:'m',yearColumn:'y'}]};
 const p=data([{id:'001',warehouse:'A'},{id:'001',warehouse:'B'}]),s=data([{id:'001',warehouse:'B',y:'2026',m:'1',amount:'0.5'}]);const load=ref=>ref==='p'?p:s;
 const d=await buildPeriodDataset(a,load);assert.equal(d.rows[4].running,'0.5');await verifyPeriodDataset(d,load);d.rows[4].running='1';await assert.rejects(verifyPeriodDataset(d,load),/重算不一致/);
 const empty=await build([],[],{...args,sources:[]});assert.equal(empty.rows.length,0);
 await assert.rejects(buildPeriodDataset(a,load,{check:()=>{throw new Error('cancelled');}}),/cancelled/);
});
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-period-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','JOB-period');
 const d=new ReportDatasets({directory,scope:'period-test',maxRows:'all'});const recipes=new Map();
 async function collect(name,rows){const statement={sql:'SELECT '+name,params:[],columns:Object.keys(rows[0]),numericColumns:name==='population'?[]:['amount'],recipe:{tool:'group_dataset',args:{name}}};recipes.set(name,{statement,rows});return d.collect(statement,pages(rows));}
 const p=await collect('population',[{id:'001'},{id:'002'}]);const movements=[{id:'001',period:'202512',amount:'0.1'},{id:'001',period:'202602',amount:'-0.02'}];const source=await collect('monthly',movements),reference=await collect('independent_detail',movements);
 const make=ref=>d.period({...args,populationRef:p.datasetRef,sources:ref?[{...args.sources[0],datasetRef:ref}]:[]});
 const grid=await make(),main=await make(source.datasetRef),baseline=await make(reference.datasetRef);
 const composeArgs={population:{datasetRef:grid.datasetRef,keyColumn:'period_key'},sources:[{name:'s1',datasetRef:main.datasetRef,keyColumn:'period_key'}],columns:['id','month','current','running'].map(column=>({label:column,value:{op:'field',source:'s1',column}}))};
 const out=await d.compose(composeArgs);const finalArgs={datasetRef:out.datasetRef,requirement:'全部对象完整月度流量和累计',expectedColumns:out.columns,scopeEvidence:'有效对象全集及指定跨年月份',populationRef:grid.datasetRef,populationKey:'period_key',columnRules:out.columns.map(label=>({label,definition:'逐对象月度明细及累计',evidence:'独立明细查询核对'})),checks:['current','running'].map(column=>({source:'s1',column,referenceRef:baseline.datasetRef,referenceColumn:column,evidence:'独立明细按相同月份汇总'}))};
 return {root,d,recipes,main,baseline,out,finalArgs,composeArgs};
}
test('persist, resume, finalize, inspect actual CSV and replay refresh with period dependencies',async t=>{
 const f=await fixture(t);f.d.clear();const final=await f.d.finalize(f.finalArgs);const audit=await inspectReport(f.root,{id:'JOB-period',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(audit.calculationAudit.checkedRows,6);assert.equal(audit.status,'verified');
 let begins=0;const refreshed=await f.d.refresh(f.finalArgs,{begin:async()=>begins++,reload:async recipe=>{const {statement,rows}=f.recipes.get(recipe.args.name);return f.d.collect(statement,pages(rows));}});assert.equal(begins,1);assert.equal(refreshed.refresh.sourceCount,3);assert.notEqual(refreshed.exportFile.id,final.exportFile.id);
 assert.equal((await readFile(path.join(f.root,'exports','JOB-period',final.exportFile.filename),'utf8')),(await readFile(path.join(f.root,'exports','JOB-period',refreshed.exportFile.filename),'utf8')));
});
test('period verification rejects same-query proof and per-row mismatches with equal totals',async t=>{
 const f=await fixture(t);await assert.rejects(f.d.finalize({...f.finalArgs,checks:f.finalArgs.checks.map(c=>({...c,referenceRef:f.main.datasetRef}))}),/同一查询/);
 const baseline=await f.d.restore(f.baseline.datasetRef);baseline.rows[0].current='0.09';baseline.rows[1].current='0.01';await assert.rejects(f.d.finalize(f.finalArgs),/重算不一致/);
});
test('wide reports and repeated draft correction no longer stop at twelve columns or four drafts',async t=>{
 const f=await fixture(t);const columns=Array.from({length:24},(_,i)=>({label:'dimension'+i,value:{op:'field',source:'s1',column:'id'}}));
 for(let i=0;i<6;i++){const out=await f.d.compose({...f.composeArgs,columns});assert.equal(out.columns.length,24);}
});

test('tool catalog exposes period expansion and reports correctable input errors',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-period-tools-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const mysql={createConnection:async()=>({query:async sql=>sql.startsWith('SHOW GRANTS')?[[{grants:'GRANT SELECT ON `demo`.* TO test'}]]:[[]],execute:async s=>s.sql.includes('information_schema.COLUMNS')?[[{table_name:'objects',column_name:'id',data_type:'varchar',engine:'InnoDB'}]]:pages([{id:'001',count:'1'}])(s),rollback:async()=>{},destroy:()=>{}})};
 const tools=await createEnvironmentTools({kind:'mysql',host:'db',database:'demo'},{tables:['objects'],maxRows:5,timeoutMs:1000,exportMaxRows:'all',exportTimeoutMs:3000},{username:'fake',password:'fake'},{mysql,exportDirectory:root});t.after(()=>tools.close());
 assert.ok(tools.spec.some(s=>s.tool==='period_dataset'));
 await tools.run('schema',{table:'objects'});
 const pop=await tools.run('group_dataset',{table:'objects',groupColumns:['id'],aggregates:[{op:'count',as:'count'}],filters:[{column:'id',op:'=',value:'001'}]});
 const out=await tools.run('period_dataset',{populationRef:pop.datasetRef,keyColumns:['id'],period,sources:[]});assert.equal(out.rowCount,3);assert.match(out.dataHash,/^[a-f0-9]{64}$/);
 await assert.rejects(tools.run('period_dataset',{populationRef:pop.datasetRef,keyColumns:['id'],period:{...period,start:'invalid'},sources:[]}),e=>e.code==='REPORT_INPUT');
});
test('independent period evidence with equal totals but different objects cannot certify rows',async t=>{
 const f=await fixture(t),old=await f.d.restore(f.baseline.datasetRef);
 const raw=await f.d.collect({sql:'SELECT independent_wrong_object',params:[],columns:['id','period','amount'],numericColumns:['amount']},pages([{id:'002',period:'2025-12',amount:'0.1'},{id:'002',period:'2026-02',amount:'-0.02'}]));
 const wrong=await f.d.period({...old.derivation.args,sources:[{...old.derivation.args.sources[0],datasetRef:raw.datasetRef}]});
 await assert.rejects(f.d.finalize({...f.finalArgs,checks:f.finalArgs.checks.map(c=>({...c,referenceRef:wrong.datasetRef}))}),/逐行核对/);
});

test('mixed compact, numeric, padded and separate months align without dropping occupancy',async()=>{
 const rows=[{id:'001',period:'202512',amount:'10'},{id:'001',period:202601,amount:'-3'},{id:'001',period:' 2026-1 ',amount:'-2'},{id:'001',period:'2026-02',amount:'1'}];
 const d=await build([{id:'001'}],rows);assert.deepEqual(d.rows.map(r=>r.running),['10','5','6']);assert.equal(d.derivation.audit.sources[0].matchedRows,4);assert.equal(d.derivation.audit.sources[0].outsideRows,0);assert.equal(d.derivation.args.periodNormalization,'calendar-v1');
 await verifyPeriodDataset(d,ref=>ref==='p'?data([{id:'001'}]):data(rows));
 await assert.rejects(build([{id:'001'}],rows,{...args,sources:[{...args.sources[0],duplicates:'error'}]}),/重复/);
});
test('invalid calendar values cannot be silently excluded and zero filled; valid outside periods remain auditable',async()=>{
 const a={...args,sources:[{...args.sources[0],outside:'exclude',outsideEvidence:'仅指定期间'}]};
 for(const period of ['202613','202600','2026-13','2026/01','',null,202601.5,'2026-01-01'])await assert.rejects(build([{id:'1'}],[{id:'1',period,amount:'1'}],a),/期间/);
 const d=await build([{id:'1'}],[{id:'1',period:'202511',amount:'1'}],a);assert.equal(d.derivation.audit.sources[0].outsideRows,1);
 const day={...args,period:{unit:'day',start:'2024-02-28',end:'2024-03-01',column:'day'}};
 assert.equal((await build([{id:'1'}],[{id:'1',period:20240229,amount:'2'}],day)).rows[1].current,'2');
 await assert.rejects(build([{id:'1'}],[{id:'1',period:'20250229',amount:'2'}],day),/日期不存在/);
});
test('old valid period proofs remain readable but compact months previously discarded require regeneration',async()=>{
 const p=data([{id:'1'}]),standard=data([{id:'1',period:'2026-01',amount:'2'}]);const old=await buildPeriodDataset(args,r=>r==='p'?p:standard,{legacy:true});await verifyPeriodDataset(old,r=>r==='p'?p:standard);
 const compact=data([{id:'1',period:'202601',amount:'2'}]);const a={...args,sources:[{...args.sources[0],outside:'exclude',outsideEvidence:'旧范围处理'}]};const broken=await buildPeriodDataset(a,r=>r==='p'?p:compact,{legacy:true});assert.equal(broken.rows[1].current,'0');await assert.rejects(verifyPeriodDataset(broken,r=>r==='p'?p:compact),/重新period_dataset/);
 const fresh=await buildPeriodDataset(a,r=>r==='p'?p:compact);assert.equal(fresh.rows[1].current,'2');await verifyPeriodDataset(fresh,r=>r==='p'?p:compact);
});
