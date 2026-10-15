import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {groupedDatasetStatement,createEnvironmentTools} from '../src/runner/environment-tools.js';
import {validateToolQuery} from '../src/shared/environment-tool-policy.js';
import {reportFile} from '../src/shared/report-files.js';
const statement={sql:'SELECT dealer,SUM(amount) AS amount FROM example GROUP BY dealer ORDER BY dealer',columns:['dealer','amount'],params:[]};
const pages=rows=>async({sql})=>{const m=sql.match(/LIMIT (\d+) OFFSET (\d+)$/);return [rows.slice(+m[2],+m[2]+ +m[1])];};
const rows=n=>Array.from({length:n},(_,i)=>({dealer:String(100000+i),amount:'0.1'}));
const field=(source,column='amount',missing='zero')=>({op:'field',source,column,missing});
const compose=(ref,more=[])=>({sources:[{name:'s1',datasetRef:ref,keyColumn:'dealer'},...more],columns:[{label:'经销商',value:{op:'key'}},{label:'金额',total:true,value:field('s1')}]});
test('complete datasets page beyond samples, prove exact-cap completion and reject over-cap reports',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const n of [0,20,500,501,1000,1001]){
  let checks=0;const d=new ReportDatasets({maxRows:1000,previewRows:5,directory:root,authorize:async()=>checks++});
  const r=await d.collect(statement,pages(rows(n)));assert.equal(r.complete,n<=1000);assert.equal(r.rowCount,Math.min(n,1000));assert.ok(r.preview.length<=5);assert.ok(checks>=3);
  if(n>1000)await assert.rejects(d.compose(compose(r.datasetRef)),/完整数据集/);
  else{const out=await d.compose(compose(r.datasetRef));assert.equal(out.rowCount,n);assert.equal(out.totals['金额'],String(n/10));const csv=await readFile(path.join(root,out.draftFile.filename),'utf8');assert.equal(csv.charCodeAt(0),0xfeff);assert.equal(csv.split('\r\n').length,n+2);}
 }
});
test('decimal union joins calculate financial balances exactly and preserve other-source dealers',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const d=new ReportDatasets({maxRows:1000,directory:root});const a=await d.collect(statement,pages([{dealer:'1',amount:'9007199254740993.12'},{dealer:'2',amount:'0.2'}]));
 const b=await d.collect(statement,pages([{dealer:'1',amount:'0.02'},{dealer:'3',amount:'0.3'}]));
 const out=await d.compose({sources:[{name:'s1',datasetRef:a.datasetRef,keyColumn:'dealer'},{name:'s2',datasetRef:b.datasetRef,keyColumn:'dealer'}],columns:[{label:'经销商',value:{op:'key'}},{label:'余额',value:{op:'subtract',args:[field('s1'),field('s2')]}},{label:'取较小值',value:{op:'min',args:[field('s1'),field('s2')]}}]});
 assert.equal(out.rowCount,3);assert.equal(out.preview[0][1],'9007199254740993.1');assert.equal(out.preview[2][1],'-0.3');assert.equal(out.totals['余额'],'9007199254740993');
 await assert.rejects(d.compose({...compose(a.datasetRef),columns:[{label:'x',value:{op:'eval',args:['process.env']}}]}),/仅支持/);
 await assert.rejects(d.compose({...compose(a.datasetRef),columns:[{label:'x',value:field('s2')}]}),/引用无效/);
});
test('duplicates, missing values, foreign refs and revoked authorization cannot silently export',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let allowed=true;const d=new ReportDatasets({maxRows:1000,directory:root,authorize:async()=>{if(!allowed)throw new Error('expired');}});
 const a=await d.collect(statement,pages([{dealer:'1',amount:'1'},{dealer:'1',amount:'2'}]));await assert.rejects(d.compose(compose(a.datasetRef)),/重复/);
 await assert.rejects(d.compose(compose('dataset-foreign')),/完整数据集/);
 const b=await d.collect(statement,pages([{dealer:'2',amount:null}]));const c=compose(b.datasetRef);delete c.columns[1].value.missing;await assert.rejects(d.compose(c),/缺失值/);
 allowed=false;await assert.rejects(d.collect(statement,pages(rows(600))),/expired/);await assert.rejects(d.compose(compose(b.datasetRef)),/expired/);
 let calls=0;const d2=new ReportDatasets({maxRows:1000,authorize:async()=>{if(++calls>3)throw new Error('expired');}});await assert.rejects(d2.collect(statement,pages(rows(600))),/expired/);assert.equal(d2.datasets.size,0);
});
test('CSV protects formula-like text and file lookup requires scope, digest and regular file',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-report-'));t.after(()=>rm(root,{recursive:true,force:true}));const dir=path.join(root,'exports','JOB-demo');
 const d=new ReportDatasets({maxRows:10,directory:dir});const r=await d.collect(statement,pages([{dealer:'1',amount:'=CMD("x")'}]));const out=await d.compose({sources:[{name:'s1',datasetRef:r.datasetRef,keyColumn:'dealer'}],columns:[{label:'编号',value:{op:'key'}},{label:'名称',value:field('s1')}]});
 const final=await d.finalize({datasetRef:out.datasetRef,requirement:'按编号列出名称',expectedColumns:out.columns,scopeEvidence:'完整名称表范围',populationRef:r.datasetRef,populationKey:'dealer',columnRules:out.columns.map(label=>({label,definition:'原始名称和编号',evidence:'名称表字段定义'})),checks:[]});
 const f=await reportFile(root,'JOB-demo',final.exportFile);assert.match(f.content.toString(),/'=CMD\(""x""\)/);
 await assert.rejects(reportFile(root,'../JOB-demo',final.exportFile));await assert.rejects(reportFile(root,'JOB-other',final.exportFile));
 await writeFile(f.file,'changed');await assert.rejects(reportFile(root,'JOB-demo',final.exportFile));
 await rm(f.file);await symlink(path.join(root,'outside'),f.file);await assert.rejects(reportFile(root,'JOB-demo',final.exportFile));
});
test('grouped SQL has validated columns, bound values, stable order and alias collisions fail',()=>{
 const tables=new Map([['budget',['dealer','amount','deleted']],['dealer',['id','name']]]),types=new Map([['budget',new Map([['amount','decimal']])]]),q={tables:['*']};
 const a={table:'budget',groupColumns:['dealer'],aggregates:[{op:'sum',column:'amount',as:'total'}],filters:[{column:'deleted',op:'=',value:0}]};
 const s=groupedDatasetStatement(a,tables,types,q);assert.match(s.sql,/GROUP BY `dealer` ORDER BY `dealer`$/);assert.deepEqual(s.params,[0]);assert.deepEqual(s.columns,['dealer','total']);
 assert.throws(()=>groupedDatasetStatement({...a,groupColumns:['dealer;DROP']},tables,types,q));assert.throws(()=>groupedDatasetStatement({...a,aggregates:[{op:'sum',column:'amount',as:'dealer'}]},tables,types,q));
 const l=groupedDatasetStatement({leftTable:'budget',rightTable:'dealer',join:{leftColumn:'dealer',rightColumn:'id'},groupColumns:[{table:'dealer',column:'id'}],aggregates:[{op:'sum',table:'budget',column:'amount',as:'total'}],filters:[{table:'budget',column:'deleted',op:'=',value:0}]},tables,types,q);assert.match(l.sql,/GROUP BY `r`.`id` ORDER BY `r`.`id`$/);
});
test('bulk export is explicit, bounded configuration, never a model override of sample maxRows',()=>{
 const e={kind:'mysql'},q={mode:'investigate',parameters:[{name:'purpose',type:'string'}],tables:['*']};assert.equal(validateToolQuery(e,{...q,exportMaxRows:10000,exportTimeoutMs:30000}),true);
 for(const extra of [{exportMaxRows:10001},{exportMaxRows:0},{exportMaxRows:10,exportTimeoutMs:999999}])assert.throws(()=>validateToolQuery(e,{...q,...extra}));
});
test('runtime tools page grouped datasets in an InnoDB readonly snapshot and propagate authorisation before every page',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-report-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[];let checks=0;
 const mysql={createConnection:async()=>({query:async sql=>{calls.push(sql);return sql.startsWith('SHOW GRANTS')?[[{'Grants':'GRANT SELECT ON `demo`.* TO test'}]]:[[]];},execute:async(s,p)=>{calls.push(s.sql);if(s.sql.includes('information_schema.COLUMNS'))return [[{table_name:'budget',column_name:'dealer',data_type:'varchar',engine:'InnoDB'},{table_name:'budget',column_name:'amount',data_type:'decimal',engine:'InnoDB'},{table_name:'budget',column_name:'deleted',data_type:'int',engine:'InnoDB'}]];return pages(rows(1001))(s,p);},rollback:async()=>{},destroy:()=>{}})};
 const e={kind:'mysql',host:'db',port:3306,database:'demo'},q={tables:['budget'],maxRows:5,timeoutMs:1000,exportMaxRows:2000,exportTimeoutMs:3000};
 const tools=await createEnvironmentTools(e,q,{username:'fake',password:'credential-never-in-results'},{mysql,exportDirectory:root,authorize:async()=>{checks++;}});t.after(()=>tools.close());
 await tools.run('schema',{table:'budget'});const r=await tools.run('group_dataset',{table:'budget',groupColumns:['dealer'],aggregates:[{op:'sum',column:'amount',as:'amount'}],filters:[{column:'deleted',op:'=',value:0}]});assert.equal(r.rowCount,1001);assert.equal(r.complete,true);assert.equal(r.preview.length,5);assert.ok(checks>=7);assert.ok(calls.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));assert.ok(calls.includes('START TRANSACTION READ ONLY'));
 const out=await tools.run('compose_report',compose(r.datasetRef));assert.equal(out.rowCount,1001);assert.equal(out.totals['金额'],'100.1');
});
test('task-local durable datasets resume precise composition and compare missing keys across rounds without SQL',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=new ReportDatasets({maxRows:1000,directory:root,scope:'same-approved-environment'});
 const a=await first.collect(statement,pages([{dealer:'1',amount:'0.1'},{dealer:'2',amount:'0.2'}]));const report=await first.compose(compose(a.datasetRef));first.clear();
 const next=new ReportDatasets({maxRows:1000,directory:root,scope:'same-approved-environment'});const catalog=await next.list();assert.equal(catalog.datasets.length,2);assert.ok(catalog.datasets.some(d=>d.datasetRef===report.datasetRef));
 const b=await next.collect(statement,pages([{dealer:'1',amount:'0.1'}]));const diff=await next.compare({leftRef:a.datasetRef,rightRef:b.datasetRef,leftKey:'dealer',rightKey:'dealer'});assert.equal(diff.onlyLeftCount,1);assert.equal(diff.onlyLeft[0].dealer,'2');assert.equal(diff.onlyRightCount,0);
 const out=await next.compose({sources:[{name:'s1',datasetRef:report.datasetRef,keyColumn:'经销商'}],columns:[{label:'编码',value:{op:'key'}},{label:'结余',total:true,value:{op:'field',source:'s1',column:'金额'}}]});assert.equal(out.rowCount,2);assert.equal(out.totals['结余'],'0.3');assert.equal(out.readAt,report.readAt);
 const foreign=new ReportDatasets({maxRows:1000,directory:root,scope:'other-environment'});assert.equal((await foreign.list()).datasets.length,0);await assert.rejects(foreign.compose(compose(a.datasetRef)),/范围/);
 const otherJob=new ReportDatasets({maxRows:1000,directory:path.join(root,'other-job'),scope:'same-approved-environment'});await assert.rejects(otherJob.compose(compose(a.datasetRef)));
});
test('persisted datasets reject tampering and renewed grants still recheck permission on restore',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-resume-security-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=new ReportDatasets({maxRows:100,directory:root,scope:'scope'}),a=await first.collect(statement,pages(rows(2)));
 const file=path.join(root,'datasets',a.datasetRef+'.json'),saved=JSON.parse(await readFile(file,'utf8'));saved.data.rows[0].amount='999';await writeFile(file,JSON.stringify(saved));
 const next=new ReportDatasets({maxRows:100,directory:root,scope:'scope'});assert.equal((await next.list()).datasets.length,0);await assert.rejects(next.compose(compose(a.datasetRef)),/摘要/);
 const revoked=new ReportDatasets({maxRows:100,directory:root,scope:'scope',authorize:async()=>{throw new Error('revoked');}});await assert.rejects(revoked.list(),/revoked/);await assert.rejects(revoked.compose(compose(a.datasetRef)),/revoked/);
});
