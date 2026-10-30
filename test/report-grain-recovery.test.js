import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {groupedDatasetStatement,linkedAggregateStatement,aggregateStatement,createEnvironmentTools} from '../src/runner/environment-tools.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {environmentContinuation} from '../src/shared/investigation-review.js';
const tables=new Map([['masters',['id','code','start_at','end_at','active']],['details',['master_id','month','category','amount','deleted']]]);
const types=new Map([['masters',new Map([['id','bigint'],['start_at','datetime'],['end_at','datetime']])],['details',new Map([['amount','decimal']])]]);
const q={tables:['masters','details'],maxRows:5,exportMaxRows:1000,timeoutMs:1000};
const args={leftTable:'masters',rightTable:'details',join:{leftColumn:'id',rightColumn:'master_id',type:'left'},groupColumns:[{table:'masters',column:'id'},{table:'masters',column:'code'},{table:'masters',column:'start_at'},{table:'masters',column:'end_at'},{table:'details',column:'month'},{table:'details',column:'category'}],aggregates:[{op:'sum',table:'details',column:'amount',as:'amount'}],filters:[{table:'masters',column:'start_at',op:'<=',value:'2026-09-30 23:59:59'},{table:'masters',column:'end_at',op:'>=',value:'2026-10-01 00:00:00'},{table:'details',column:'deleted',op:'=',value:0}]};
test('one-to-many grouped LEFT JOIN keeps all68 masters and139 details, nulls and inclusive dates',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'grain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE masters(id TEXT,code TEXT,start_at TEXT,end_at TEXT,active INT);CREATE TABLE details(master_id TEXT,month TEXT,category TEXT,amount INT,deleted INT)');
 const add=db.prepare('INSERT INTO masters VALUES(?,?,?,?,1)');for(let i=0;i<68;i++)add.run(String(i),'P'+i,'2026-09-30 00:00:00','2026-10-01 00:00:00');
 const detail=db.prepare('INSERT INTO details VALUES(?,?,?,?,?)');for(let i=0;i<139;i++)detail.run(String(i%31),String(i),'X',i+1,0);
 detail.run('67','deleted','X',999,1); // A master with only ineligible details must remain unmatched.
 add.run('outside','out','2026-10-01 00:00:00','2026-10-01 00:00:00');
 const s=groupedDatasetStatement({...args,rowKey:'row_key'},tables,types,q);assert.match(s.sql,/LEFT JOIN.*ON.*`r`.`deleted` = \? WHERE/s);assert.deepEqual(s.params,[0,'2026-09-30 23:59:59','2026-10-01 00:00:00']);
 const d=new ReportDatasets({maxRows:1000,directory:root,scope:'fixture'});const execute=async({sql},p)=>[db.prepare(sql).all(...p).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v===null?null:String(v)])))];const out=await d.collect(s,execute);
 const all=await d.restore(out.datasetRef);assert.equal(all.rows.length,176);assert.equal(new Set(all.rows.map(r=>r.id)).size,68);assert.equal(all.rows.filter(r=>r.amount===null).length,37);assert.equal(all.rows.reduce((sum,r)=>sum+Number(r.amount??0),0),9730);assert.ok(all.rows.every(r=>r.end_at==='2026-10-01 00:00:00'));
 assert.equal(new Set(all.rows.map(r=>r.row_key)).size,176);
 const population=await d.collect(groupedDatasetStatement({...args,rowKey:'row_key',aggregates:[{op:'count',table:'details',column:'master_id',as:'detail_count'}]},tables,types,q),execute);
 const ref=await d.collect({sql:'SELECT SUM(amount) AS amount FROM details WHERE deleted=0',columns:['amount'],numericColumns:['amount'],params:[]},execute);
 const columns=[{label:'方案',value:{op:'field',source:'s1',column:'code'}},{label:'执行开始',value:{op:'field',source:'s1',column:'start_at'}},{label:'月份',value:{op:'field',source:'s1',column:'month',missing:'empty'}},{label:'预算',total:true,value:{op:'field',source:'s1',column:'amount',missing:'zero'}}];
 const draft=await d.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'row_key'}],columns});
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'所有跨期方案按月展示，含无明细方案；本合成测试约定无明细预算按零',scopeEvidence:'完整主对象及月份分类组合，包括无明细对象',expectedColumns:columns.map(c=>c.label),populationRef:population.datasetRef,populationKey:'row_key',columnRules:columns.map(c=>({label:c.label,definition:'合成固定测试字段，预算无明细按零',evidence:'合成测试表和明确左关联规则'})),checks:[{source:'s1',column:'amount',referenceRef:ref.datasetRef,referenceColumn:'amount',evidence:'独立原始明细全量求和'}]});assert.equal(final.exportFile.rowCount,176);
 const inner=groupedDatasetStatement({...args,join:{...args.join,type:'inner'}},tables,types,q);assert.equal(db.prepare(inner.sql).all(...inner.params).length,139);
 }finally{db.close();}
});
test('left joins retain authorized full masters with right eligibility and reject unknown joins or injected fields',()=>{
 const full=linkedAggregateStatement({...args,filters:args.filters.filter(f=>f.table==='details')},tables,types,q);assert.match(full.sql,/ON .* AND .* WHERE 1=1/);assert.ok(full.params.length>0);
 assert.match(linkedAggregateStatement({...args,filters:[]},tables,types,q).sql,/WHERE 1=1/);
 for(const type of ['right','full','left;DELETE'])assert.throws(()=>linkedAggregateStatement({...args,join:{...args.join,type}},tables,types,q));
 for(const rowKey of ['__proto__','constructor','password','amount','bad;DROP'])assert.throws(()=>groupedDatasetStatement({...args,rowKey},tables,types,q));
 assert.throws(()=>groupedDatasetStatement({...args,groupColumns:[{table:'details',column:'amount;DROP'}]},tables,types,q));
 assert.doesNotMatch(linkedAggregateStatement({...args,join:{leftColumn:'id',rightColumn:'master_id'}},tables,types,q).sql,/LEFT JOIN/);
});
test('real tool adapter asks MySQL for date strings and preserves decimal precision and database clock values',async()=>{
 let options;const driver={createConnection:async o=>{options=o;return {query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async({sql})=>sql.includes('information_schema')?[tables.get('masters').map(column_name=>({table_name:'masters',column_name,data_type:column_name.endsWith('_at')?'datetime':'varchar',engine:'InnoDB'}))]:[[{id:'9223372036854775807',start_at:o.dateStrings?'2026-09-30 00:00:00':new Date('2026-09-30T00:00:00Z'),amount:'9007199254740993.12'}]],rollback:async()=>{},destroy:()=>{}};}};
 const tools=await createEnvironmentTools({kind:'mysql',host:'test',database:'demo'},q,{username:'reader',password:'not-a-real-secret'},{mysql:driver});try{await tools.run('schema',{table:'masters'});assert.equal(options.dateStrings,true);const r=await tools.run('group_dataset',{table:'masters',groupColumns:['id','start_at'],aggregates:[{op:'count',column:'id',as:'amount'}],filters:[{column:'active',op:'=',value:1}]});assert.equal(r.preview[0].start_at,'2026-09-30 00:00:00');assert.equal(r.preview[0].amount,'9007199254740993.12');}finally{await tools.close();}
});
test('unsupported report values name the column/type without including values; unsafe monetary numbers still fail',async()=>{
 const d=new ReportDatasets({maxRows:10}),s={sql:'SELECT event_date',params:[],columns:['event_date']};
 await assert.rejects(d.collect(s,async()=>[[{event_date:new Date('2026-09-30')}]]),e=>/event_date.*Date/.test(e.message)&&!e.message.includes('2026'));
 await assert.rejects(d.collect(s,async()=>[[{event_date:{private:'must-not-appear'}}]]),e=>!e.message.includes('must-not-appear')&&/类型object/.test(e.message));
 await assert.rejects(d.collect(s,async()=>[[{event_date:0.1}]]),/精确字符串/);
});
const request={environmentId:'db',queryId:'investigate',goalIds:['original-question'],parameters:['use correct grain']};
const current={investigation:{goals:[{id:'original-question',required:true,status:'open',evidence:'needs joined report'}]}};
function job(errors){return {id:'j',questionId:'q',taskIntent:'analysis',investigationProgress:{stagnant:2},context:[{kind:'environment_result',result:{environmentEvidence:{environmentId:'db',queryId:'investigate'},toolInputErrors:errors}}]};}
test('stalled report may repair concrete input failures once per category, wording cannot reset recovery',()=>{
 const j=job([{tool:'enrich_dataset',code:'REPORT_INPUT',message:'覆盖核验主键必须为非空唯一字符串',resolved:false}]);let decision=environmentContinuation({jobs:[j]},j,request,current);assert.equal(decision.continue,true);assert.equal(decision.metadata.toolCorrectionKeys.length,1);
 j.investigationProgress.toolCorrections=decision.metadata.toolCorrectionKeys;
 assert.equal(environmentContinuation({jobs:[j]},j,{...request,parameters:['different wording']},current).terminal,true);
 j.context[0].result.toolInputErrors[0].tool='compose_report';j.context[0].result.toolInputErrors[0].message='来源主键为空或重复';assert.equal(environmentContinuation({jobs:[j]},j,request,current).terminal,true);
 j.context[0].result.toolInputErrors=[{tool:'group_dataset',code:'REPORT_INPUT',message:'报表含不支持的字段值',resolved:false}];assert.equal(environmentContinuation({jobs:[j]},j,request,current).continue,true);
});
test('tool recovery never bypasses runtime failure, changed environment, resolved errors or unknown/optional goals',()=>{
 for(const errors of [[{tool:'enrich_dataset',code:'REPORT_INPUT',message:'覆盖核验主键必须',resolved:true}],[{tool:'enrich_dataset',code:'EXECUTION_ERROR',message:'覆盖核验主键必须',resolved:false}]]){const j=job(errors);assert.equal(environmentContinuation({jobs:[j]},j,request,current).terminal,true);}
 const j=job([{tool:'enrich_dataset',code:'REPORT_INPUT',message:'覆盖核验主键必须',resolved:false}]);
 for(const r of [{...request,environmentId:'other'},{...request,goalIds:['missing']},{...request,goalIds:undefined}])assert.equal(environmentContinuation({jobs:[j]},j,r,current).continue,false);
 j.context[0].result.environmentFailure={code:'TIMEOUT'};assert.equal(environmentContinuation({jobs:[j]},j,request,current).terminal,true);
});

test('correction receipts persist in state and distinguish same-purpose recovery from repeated calls',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'correction-state-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'state.json'),store=new JsonStore(file),identity={runnerId:'r',leaseId:'l'};
 await store.transact(s=>s.jobs.push({...job([]),stage:'developer',continuousInvestigation:true,status:'running',lease:{id:'l',runnerId:'r',expiresAt:new Date(Date.now()+60000).toISOString()},events:[]}));
 const plan={...request};await store.beginContinuousEnvironment('j',identity,plan,current);
 await store.transact(s=>{delete s.jobs[0].environmentAccess;s.jobs[0].investigationProgress.stagnant=2;});
 const key='a'.repeat(64);await store.beginContinuousEnvironment('j',identity,{...plan,toolCorrectionKeys:[key]},current);
 const after=await new JsonStore(file).getJob('j');assert.deepEqual(after.investigationProgress.toolCorrections,[key]);assert.equal(after.investigationProgress.stagnant,0);
 await store.transact(s=>delete s.jobs[0].environmentAccess);
 await assert.rejects(store.beginContinuousEnvironment('j',identity,{...plan,toolCorrectionKeys:[key]},current),e=>e.code==='DUPLICATE_QUERY');
 await assert.rejects(store.beginContinuousEnvironment('j',{...identity,leaseId:'foreign'},{...plan,toolCorrectionKeys:['b'.repeat(64)]},current));
});

test('malformed aggregate containers produce correctable input errors instead of executor failures',()=>{
 for(const aggregates of [undefined,null,{},'sum',1]){
  for(const run of [()=>aggregateStatement({table:'details',aggregates,filters:[{column:'deleted',op:'=',value:0}]},tables,types,q),()=>linkedAggregateStatement({...args,aggregates},tables,types,q)])assert.throws(run,e=>e.code==='QUERY_INPUT'&&/aggregates/.test(e.message));
 }
});
