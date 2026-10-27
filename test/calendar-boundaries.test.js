import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCalendarPeriod,buildPeriodDataset,verifyPeriodDataset} from '../src/shared/period-dataset.js';
import {deploymentTimestamp,deploymentEvidence} from '../src/shared/deployment-evidence.js';
import {queryEvidenceIdentity} from '../src/shared/query-evidence.js';
const data=rows=>({rows,columns:Object.keys(rows[0]??{}),complete:true,readAt:'2026-01-03T00:00:00Z',snapshotId:'s'});
const args={populationRef:'p',keyColumns:['id'],period:{unit:'month',start:'2025-12',end:'2026-02',column:'period'},sources:[{datasetRef:'s',keyColumns:['id'],periodColumn:'month',duplicates:'error',outside:'exclude',outsideEvidence:'explicit business scope',metrics:[{column:'amount',as:'amount',cumulativeAs:'running',statusAs:'state',missing:'zero',nulls:'empty'}]}]};
const build=(source,a=args)=>buildPeriodDataset(a,ref=>ref==='p'?data([{id:'a'},{id:'b'}]):data(source));

test('calendar normalization accepts all supported month forms and strictly defined days',()=>{
 for(const v of ['202601',202601,'2026-01','2026-1'])assert.equal(normalizeCalendarPeriod(v,'month'),'2026-01');
 for(const v of ['20240229',20240229,'2024-02-29'])assert.equal(normalizeCalendarPeriod(v,'day'),'2024-02-29');
 for(const v of [null,undefined,'',202601.1,'2026-00','2026-13','0000-01','2026-01-01T00:00:00Z'])assert.throws(()=>normalizeCalendarPeriod(v,'month'));
 for(const v of ['20260229','2026-02-30','2026-0230','202602-28','2026-02-28T00:00:00+08:00',new Date()])assert.throws(()=>normalizeCalendarPeriod(v,'day'));
});
test('invalid source periods fail even outside the population; missing and unknown have distinct row states',async()=>{
 for(const month of [null,'','2026-13','2026-01-01T00:00:00Z'])await assert.rejects(build([{id:'outside',month,amount:'99'}]),/期间|日期/);
 const d=await build([{id:'a',month:'2025-12',amount:null},{id:'a',month:202601,amount:'0'}]);
 assert.deepEqual(d.rows.slice(0,3).map(r=>[r.state,r.amount]),[['unknown',null],['known','0'],['no_occurrence','0']]);
 assert.ok(d.rows.slice(3).every(r=>r.state==='no_occurrence'));
 assert.equal(d.derivation.args.periodNormalization,'calendar-v2');
});
test('normalization does not silently choose duplicate rows; amounts reject unsafe numeric values',async()=>{
 await assert.rejects(build([{id:'a',month:'202601',amount:'1'},{id:'a',month:'2026-1',amount:'2'}]),/重复/);
 for(const amount of [0.1,Number.MAX_SAFE_INTEGER+1,Infinity])await assert.rejects(build([{id:'a',month:'202601',amount}]),/金额/);
 const d=await build([{id:'a',month:'202601',amount:'9007199254740993.000000000001'}]);assert.equal(d.rows[1].amount,'9007199254740993.000000000001');
});
test('custom periods retain explicit meanings; null and numeric custom keys are not excluded and zero-filled',async()=>{
 const a={...args,period:{unit:'values',values:['202601','FY-Q1'],column:'period'}};
 const d=await build([{id:'a',month:'202601',amount:'3'}],a);assert.equal(d.rows[0].amount,'3');assert.equal(d.rows[1].amount,'0');
 for(const month of [null,202601])await assert.rejects(build([{id:'outside',month,amount:'4'}],a),/自定义期间/);
});
test('old correct calendar-v1 and unversioned canonical recipes remain replayable',async()=>{
 const source=data([{id:'a',month:'2026-01',amount:'2'}]),population=data([{id:'a'}]),load=r=>r==='p'?population:source;
 const oldArgs={...args,periodNormalization:'calendar-v1'};const old=await buildPeriodDataset(oldArgs,load);await verifyPeriodDataset(old,load);
 const unversioned=await buildPeriodDataset(args,load,{legacy:true});await verifyPeriodDataset(unversioned,load);
 const wrong=await buildPeriodDataset(args,r=>r==='p'?population:data([{id:'a',month:'202601',amount:'9'}]),{legacy:true});
 await assert.rejects(verifyPeriodDataset(wrong,r=>r==='p'?population:data([{id:'a',month:'202601',amount:'9'}])),/重新period_dataset/);
});
test('restoration cycles are detected by dataset references even when each load returns a fresh object',async()=>{
 const cycle={complete:true,derivation:{kind:'left_lookup',datasetRef:'cycle',lookups:[]}};
 await assert.rejects(verifyPeriodDataset(cycle,()=>structuredClone(cycle)),/循环/);
});
test('renaming output aliases and formatting does not create independent query evidence',()=>{
 const make=sql=>({queryHash:sql,queryDefinition:{sql,params:['1']}});
 assert.equal(queryEvidenceIdentity(make('SELECT SUM(`amount`) AS `one` FROM `detail` WHERE `id` = ?')),queryEvidenceIdentity(make('select  sum(`amount`) as `two` from `detail` where `id` = ?')));
 assert.notEqual(queryEvidenceIdentity(make('SELECT SUM(`amount`) AS `one` FROM `detail`')),queryEvidenceIdentity(make('SELECT `id`,SUM(`amount`) AS `one` FROM `detail` GROUP BY `id`')));
 assert.notEqual(queryEvidenceIdentity(make("SELECT 'ABC' AS value")),queryEvidenceIdentity(make("SELECT 'abc' AS value")));
});
test('deployment time requires real timestamp semantics and never assumes local timezone or epoch unit',()=>{
 assert.equal(deploymentTimestamp('2026-01-02 09:30:00',{offset:'+08:00'}),'2026-01-02T01:30:00.000Z');
 assert.equal(deploymentTimestamp(0,{timestampUnit:'seconds'}),'1970-01-01T00:00:00.000Z');
 for(const v of ['2026-01-02','2026-01-02 09:30:00','2026-02-30T09:30:00Z',1760000000])assert.throws(()=>deploymentTimestamp(v));
 assert.throws(()=>deploymentTimestamp('2026-01-02 09:30:00',{offset:'Asia/Shanghai'}));
});
test('release evidence binds two systems and different environments, filters failed releases and preserves source time',()=>{
 const rows=[{system:'tpm',env:'prd',app:'gateway',at:'2026-01-02T09:30:00+08:00',status:'ok',sha:'1234567'},{system:'ltx',env:'sit',app:'gateway',at:'2026-01-03T09:30:00+08:00',status:'ok',sha:'7654321'},{system:'tpm',env:'prd',app:'gateway',at:'2026-01-04T09:30:00+08:00',status:'failed',sha:'1111111'}];
 const d={...data(rows),queryHash:'original',queryDefinition:{sql:'SELECT release_records',params:[]}};
 const a={datasetRef:'scoped',application:'gateway',columns:{system:'system',environment:'env',application:'app',deployedAt:'at',status:'status',commit:'sha'},successValues:['ok'],evidence:'actual release audit table'};
 const tpm=deploymentEvidence(a,d,{projectId:'tpm',environment:'prd'}),ltx=deploymentEvidence(a,d,{projectId:'ltx',environment:'sit'});
 assert.equal(tpm.records.length,1);assert.equal(tpm.records[0].commit,'1234567');assert.equal(tpm.audit.unsuccessfulRows,1);assert.equal(ltx.records[0].commit,'7654321');assert.equal(tpm.source.readAt,d.readAt);
 assert.equal(deploymentEvidence(a,d,{projectId:'ltx',environment:'prd'}).deploymentVerified,false);
 assert.throws(()=>deploymentEvidence(a,{...d,queryDefinition:null},{projectId:'tpm',environment:'prd'}),/原始发布记录/);
});
