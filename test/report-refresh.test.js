import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
async function fixture(t,recipe=true){const root=await mkdtemp(path.join(os.tmpdir(),'report-refresh-'));t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({maxRows:10,directory:root,scope:'same'});const collect=async(kind,columns,rows)=>d.collect({sql:kind,params:[],columns,numericColumns:columns.includes('amount')?['amount']:[],recipe:recipe?{tool:'group_dataset',args:{table:kind,groupColumns:columns.filter(c=>c!=='amount'),aggregates:columns.includes('amount')?[{op:'sum',column:'amount',as:'amount'}]:[]}}:undefined},async()=>[rows]);
 const population=await collect('customers',['id','name'],[{id:'1',name:'A'},{id:'2',name:'B'}]),amount=await collect('amounts',['id','amount'],[{id:'1',amount:'1'},{id:'2',amount:'2'}]),baseline=await collect('baseline',['year','amount'],[{year:'2026',amount:'3'}]);
 const draft=await d.compose({sources:[{name:'s1',datasetRef:amount.datasetRef,keyColumn:'id'},{name:'s2',datasetRef:population.datasetRef,keyColumn:'id'}],columns:[{label:'名称',value:{op:'field',source:'s2',column:'name'}},{label:'金额',value:{op:'field',source:'s1',column:'amount'}}]});
 const args={datasetRef:draft.datasetRef,requirement:'all customers amount file',expectedColumns:draft.columns,scopeEvidence:'all current customers',populationRef:population.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'source business rule',evidence:'reviewed business specification'})),checks:[{source:'s1',column:'amount',referenceRef:baseline.datasetRef,referenceColumn:'amount',evidence:'independent same-scope total'}]};return {d,args,root};}
test('refresh replays structured tool recipes once in a new snapshot and reruns final checks',async t=>{
 const f=await fixture(t);let began=0;const seen=[];
 const output=await f.d.refresh(f.args,{begin:async()=>{began++;},reload:async recipe=>{seen.push(recipe.args.table);const rows=recipe.args.table==='customers'?[{id:'1',name:'A'},{id:'2',name:'B'}]:recipe.args.table==='amounts'?[{id:'1',amount:'4'},{id:'2',amount:'5'}]:[{year:'2026',amount:'9'}];return f.d.collect({sql:'new '+recipe.args.table,params:[],columns:Object.keys(rows[0]),numericColumns:rows[0].amount?['amount']:[],recipe},async()=>[rows]);}});
 assert.equal(began,1);assert.equal(new Set(seen).size,3);assert.equal(output.coverage.rowCount,2);assert.equal(output.totals[0].total,'9');assert.ok(output.exportFile.verificationHash);assert.notEqual(output.refreshedDatasetRef,f.args.datasetRef);
});
test('legacy SQL without structured recipe cannot be replayed and old artifacts remain readable',async t=>{
 const f=await fixture(t,false);let began=0;await assert.rejects(f.d.refresh(f.args,{begin:async()=>began++,reload:async()=>assert.fail('must not execute')}),/recipe/);assert.equal(began,0);assert.equal((await f.d.inspect({datasetRef:f.args.datasetRef})).rowCount,2);
});
test('real environment tool refresh starts a second readonly transaction and revalidates table scope',async t=>{
 const {createEnvironmentTools}=await import('../src/runner/environment-tools.js');const root=await mkdtemp(path.join(os.tmpdir(),'report-refresh-tools-'));t.after(()=>rm(root,{recursive:true,force:true}));let starts=0,rollbacks=0;
 const mysql={createConnection:async()=>({query:async sql=>{if(sql==='START TRANSACTION READ ONLY')starts++;return sql.startsWith('SHOW GRANTS')?[[{Grants:'GRANT SELECT ON `demo`.* TO tester'}]]:[[]];},execute:async(s,p)=>{
  if(s.sql.includes('information_schema.COLUMNS'))return [[...['id','amount','year'].map(column_name=>({table_name:p[1],column_name,data_type:column_name==='amount'?'decimal':'varchar',engine:'InnoDB'}))]];
  return [s.sql.includes('`baseline`')?[{year:'2026',amount:'3'}]:s.sql.includes('`amounts`')?[{id:'1',amount:'1'},{id:'2',amount:'2'}]:[{id:'1',count:'1'},{id:'2',count:'1'}]];
 },rollback:async()=>{rollbacks++;},destroy:()=>{}})};
 const q={tables:['customers','amounts','baseline'],maxRows:5,timeoutMs:1000,exportMaxRows:10,exportTimeoutMs:3000},tools=await createEnvironmentTools({kind:'mysql',host:'db',port:3306,database:'demo'},q,{username:'tester',password:'private-secret'},{mysql,exportDirectory:root});t.after(()=>tools.close());
 for(const table of q.tables)await tools.run('schema',{table});
 const population=await tools.run('group_dataset',{table:'customers',filters:[{column:'year',op:'=',value:'2026'}],groupColumns:['id'],aggregates:[{op:'count',as:'count'}]});
 const amount=await tools.run('group_dataset',{table:'amounts',filters:[{column:'year',op:'=',value:'2026'}],groupColumns:['id'],aggregates:[{op:'sum',column:'amount',as:'amount'}]});
 const baseline=await tools.run('group_dataset',{table:'baseline',filters:[{column:'year',op:'=',value:'2026'}],groupColumns:['year'],aggregates:[{op:'sum',column:'amount',as:'amount'}]});
 const draft=await tools.run('compose_report',{sources:[{name:'s1',datasetRef:amount.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'金额',value:{op:'field',source:'s1',column:'amount'}}]});
 const final=await tools.run('refresh_report',{datasetRef:draft.datasetRef,requirement:'完整客户金额清单',expectedColumns:draft.columns,scopeEvidence:'所有客户同年度业务范围',populationRef:population.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'已核实字段含义',evidence:'已审阅业务来源规则'})),checks:[{source:'s1',column:'amount',referenceRef:baseline.datasetRef,referenceColumn:'amount',evidence:'同范围按年度独立汇总'}]});
 assert.equal(starts,2);assert.equal(rollbacks,1);assert.equal(final.refresh.sourceCount,3);assert.equal(final.totals[0].total,'3');
});
test('refresh cannot finalize inconsistent new totals and does not replace the old draft',async t=>{
 const f=await fixture(t);await assert.rejects(f.d.refresh(f.args,{begin:async()=>{},reload:async recipe=>{
 const rows=recipe.args.table==='customers'?[{id:'1',name:'A'},{id:'2',name:'B'}]:recipe.args.table==='amounts'?[{id:'1',amount:'4'},{id:'2',amount:'5'}]:[{year:'2026',amount:'8'}];return f.d.collect({sql:'changed '+recipe.args.table,params:[],columns:Object.keys(rows[0]),numericColumns:rows[0].amount?['amount']:[],recipe},async()=>[rows]);}}),/合计不一致/);assert.equal((await f.d.inspect({datasetRef:f.args.datasetRef})).rowCount,2);
});
test('refresh rebuilds derived lookups from fresh dependencies instead of keeping old dimension values',async t=>{
 const f=await fixture(t),old=await f.d.restore(f.args.datasetRef),amountRef=old.reportDraft.sources[0].datasetRef;
 const enriched=await f.d.enrich({datasetRef:amountRef,keyColumn:'id',lookups:[{name:'name',datasetRef:f.args.populationRef,sourceColumn:'id',targetColumn:'id',fields:[{column:'name',as:'display'}],missing:'empty'}]});
 const draft=await f.d.compose({sources:[{name:'s1',datasetRef:enriched.datasetRef,keyColumn:'id'}],columns:[{label:'名称',value:{op:'field',source:'s1',column:'display'}},{label:'金额',value:{op:'field',source:'s1',column:'amount'}}]});
 const result=await f.d.refresh({...f.args,datasetRef:draft.datasetRef},{begin:async()=>{},reload:async recipe=>{const rows=recipe.args.table==='customers'?[{id:'1',name:'fresh A'},{id:'2',name:'fresh B'}]:recipe.args.table==='amounts'?[{id:'1',amount:'4'},{id:'2',amount:'5'}]:[{year:'2026',amount:'9'}];return f.d.collect({sql:'fresh '+recipe.args.table,params:[],columns:Object.keys(rows[0]),numericColumns:rows[0].amount?['amount']:[],recipe},async()=>[rows]);}});
 assert.equal((await f.d.restore(result.refreshedDatasetRef)).rows[0]['名称'],'fresh A');assert.equal(result.refresh.sourceCount,3);
});
