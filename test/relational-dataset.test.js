import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile,mkdir,symlink} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {transformDataset,parseExactJson,verifyRelationalDataset} from '../src/shared/relational-dataset.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';import {rowDatasetStatement} from '../src/runner/environment-tools.js';
import {reusableReportSources,importReportDataset} from '../src/runner/report-reuse.js';
const data=(rows,columns)=>({rows,columns,numericColumns:[],complete:true,readAt:new Date().toISOString(),snapshotId:'snapshot'});
const expanded={datasetRef:'raw',column:'items',keyColumns:['id'],fields:[{path:['code'],as:'code'}],empty:'keep',rowKey:'item_key'};
test('JSON array expansion keeps exact big numeric IDs, leading zeros, duplicates, empty parents and full long strings',async()=>{
 const raw=data([{id:'1',items:'[{"code":90071992547409931234},{"code":"00001"},{"code":"00001"}]'},{id:'2',items:'[]'}],['id','items']);const out=await transformDataset('expand_dataset',expanded,async()=>raw);
 assert.equal(out.rows.length,4);assert.equal(out.rows[0].code,'90071992547409931234');assert.equal(out.rows[1].code,'00001');assert.equal(out.rows[3].code,null);assert.equal(new Set(out.rows.map(r=>r.item_key)).size,4);assert.equal(out.readAt,raw.readAt);await verifyRelationalDataset(out,async()=>raw);out.rows.pop();await assert.rejects(verifyRelationalDataset(out,async()=>raw),/重放不一致/);
 assert.equal(parseExactJson('[1.00000000000000000001]')[0],'1.00000000000000000001');
});
test('bad JSON, non-array and duplicate parent keys do not silently discard rows',async()=>{
 for(const rows of [[{id:'1',items:'{' }],[{id:'1',items:'{}'}],[{id:'1',items:'[]'},{id:'1',items:'[]'}]])await assert.rejects(transformDataset('expand_dataset',expanded,async()=>data(rows,['id','items'])));
 await assert.rejects(transformDataset('expand_dataset',{...expanded,fields:[{path:['__proto__'],as:'x'}]},async()=>data([],['id','items'])));
});
test('many left join keeps missing rows and rejects accidental dimension multiplication under one',async()=>{
 const l=data([{id:'a'},{id:'b'},{id:null}],['id']),r=data([{id:'a',value:'1'},{id:'a',value:'2'}],['id','value']);const load=async ref=>ref==='l'?l:r;
 const a={leftRef:'l',rightRef:'r',leftKeys:['id'],rightKeys:['id'],join:'left',cardinality:'many',fields:[{column:'value',as:'v'}],rowKey:'key'};const out=await transformDataset('join_dataset',a,load);assert.equal(out.rows.length,4);assert.equal(out.derivation.audit.unmatchedLeftRows,2);assert.equal(out.rows[3].v,null);await assert.rejects(transformDataset('join_dataset',{...a,cardinality:'one'},load),/右表键重复/);
});
test('union is explicit and rejects same-key conflicting fields; filtering reuses exact dates and decimal values',async()=>{
 const a=data([{id:'0001',start:'2025-12-31',end:'2026-01-01',amount:'9007199254740993.1'},{id:'0002',start:'2027-01-01',end:'2027-12-31',amount:'0.1'}],['id','start','end','amount']);
 const args={datasetRefs:['a','a'],columns:a.columns,keyColumns:['id'],rowKey:'key',duplicates:'distinct',evidence:'同一完整业务键重复来源核对'};const union=await transformDataset('union_dataset',args,async()=>a);assert.equal(union.rows.length,2);assert.equal(union.derivation.audit.duplicateRows,2);
 const out=await transformDataset('filter_dataset',{datasetRef:'a',match:'all',filters:[{column:'start',type:'date',op:'<=',value:'2026-12-31'},{column:'end',type:'date',op:'>=',value:'2026-01-01'},{column:'amount',type:'decimal',op:'>',value:'9007199254740993.09'}]},async()=>a);assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'0001');assert.equal(out.readAt,a.readAt);
 await assert.rejects(transformDataset('union_dataset',{...args,datasetRefs:['a','b']},async ref=>ref==='a'?a:{...a,rows:[{...a.rows[0],amount:'9'}]}),/冲突/);
});
test('raw rows are schema-bound and complete JSON strings are not clipped in full collection',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'raw-json-'));t.after(()=>rm(root,{recursive:true,force:true}));const q={tables:['examples']};const tables=new Map([['examples',['id','items']]]);
 const s=rowDatasetStatement({table:'examples',columns:['id','items'],orderBy:['id'],filters:[]},tables,new Map(),q);assert.match(s.sql,/ORDER BY `id`/);assert.doesNotMatch(s.sql,/GROUP BY/);
 assert.throws(()=>rowDatasetStatement({table:'other',columns:['id'],orderBy:['id'],filters:[]},tables,new Map(),q));
 const d=new ReportDatasets({directory:root,scope:'scope',maxRows:'all'}),text=JSON.stringify(Array.from({length:1200},(_,i)=>({code:String(i)})));
 const r=await d.collect(s,async()=>[[{id:'one',items:text}]]);assert.equal((await d.restore(r.datasetRef)).rows[0].items,text);const x=await d.transform('expand_dataset',{...expanded,datasetRef:r.datasetRef});assert.equal(x.rowCount,1200);
});
test('followup reuse requires explicit ancestor plus same actor/environment, validates closure and keeps original times',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dataset-reuse-'));t.after(()=>rm(root,{recursive:true,force:true}));const base={projectId:'p',chatId:'g',senderId:'u',originProfile:'owner',sourceEnvironment:'prd',taskIntent:'analysis'};const first={...base,id:'JOB-first',questionId:'q1'},second={...base,id:'JOB-second',questionId:'q2'};
 const state={jobs:[first,second],questions:{q1:{id:'q1',projectId:'p',chatId:'g',senderId:'u',profile:'owner'},q2:{id:'q2',parentQuestionId:'q1',projectId:'p',chatId:'g',senderId:'u',profile:'owner'}}};await writeFile(path.join(root,'agentos.json'),JSON.stringify(state));
 const d=new ReportDatasets({directory:path.join(root,'exports',first.id),scope:'same',maxRows:'all'});const raw=await d.collect({sql:'SELECT id,items FROM example ORDER BY id',params:[],columns:['id','items']},async()=>[[{id:'1',items:'[{"code":"001"}]'}]]);const expandedResult=await d.transform('expand_dataset',{...expanded,datasetRef:raw.datasetRef});
 const sources=await reusableReportSources(root,second,'same');assert.equal(sources.length,1);const current=new ReportDatasets({directory:path.join(root,'exports',second.id),scope:'same',maxRows:'all'});const result=await importReportDataset(current,{sourceJobId:first.id,datasetRef:expandedResult.datasetRef},sources,root);assert.equal(result.rowCount,1);assert.equal(result.readAt,expandedResult.readAt);assert.equal(result.importedDatasets,2);
 assert.deepEqual(await reusableReportSources(root,{...second,senderId:'other'},'same'),[]);
 assert.deepEqual(await reusableReportSources(root,second,'other-env'),[]);
 delete state.questions.q2.parentQuestionId;await writeFile(path.join(root,'agentos.json'),JSON.stringify(state));assert.deepEqual(await reusableReportSources(root,second,'same'),[]);
});
test('derived full list can be certified, inspected and filtered without new reads',async t=>{
 const {inspectReport}=await import('../src/shared/report-inspection.js');const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'json-cert-'));t.after(()=>rm(root,{recursive:true,force:true}));const dir=path.join(root,'exports','JOB-cert');const d=new ReportDatasets({directory:dir,scope:'scope',maxRows:'all'});let reads=0;
 const source=await d.collect({sql:'SELECT id,items FROM example ORDER BY id',params:[],columns:['id','items']},async()=>{reads++;return [[{id:'001',items:'[{"code":"0007"},{"code":"0008"}]'},{id:'002',items:'[]'}]];});
 const out=await d.transform('expand_dataset',{...expanded,datasetRef:source.datasetRef});const draft=await d.compose({sources:[{name:'s1',datasetRef:out.datasetRef,keyColumn:'item_key'}],columns:[{label:'对象编号',value:{op:'field',source:'s1',column:'id'}},{label:'子项编码',value:{op:'field',source:'s1',column:'code',missing:'empty'}}]});
 const final=await d.finalize({datasetRef:draft.datasetRef,populationRef:out.datasetRef,populationKey:'item_key',requirement:'导出全部对象及子项',scopeEvidence:'原始对象完整分页，逐项展开并保留空数组',expectedColumns:['对象编号','子项编码'],columnRules:[{label:'对象编号',definition:'原对象编号',evidence:'schema中的id字段'},{label:'子项编码',definition:'数组中每项编码，空数组保留空值',evidence:'结构定义code字段'}],checks:[]});
 assert.equal(final.exportFile.rowCount,3);assert.equal(reads,1);const body=await readFile(path.join(dir,final.exportFile.filename),'utf8');assert.match(body,/0007/);assert.match(body,/002/);
 const info=await inspectReport(root,{id:'JOB-cert',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(info.status,'verified');assert.equal(info.calculationAudit.checkedRows,3);
});
test('schema ordering keys reject duplicate pages before publishing a complete dataset',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'stable-rows-'));t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({directory:root,scope:'scope',maxRows:'all'});
 await assert.rejects(d.collect({sql:'SELECT id FROM test ORDER BY id',params:[],columns:['id'],uniqueKeyColumns:['id']},async()=>[[{id:'same'},{id:'same'}]]),/唯一键/);assert.equal((await d.list()).totalCount,0);
});
test('invalid dates do not silently roll into the next month and status fields cannot overwrite data',async()=>{
 const d=data([{id:'1',date:'2026-02-31'}],['id','date']);await assert.rejects(transformDataset('filter_dataset',{datasetRef:'d',match:'all',filters:[{column:'date',type:'date',op:'>=',value:'2026-01-01'}]},async()=>d),/日期/);
 const a={leftRef:'d',rightRef:'d',leftKeys:['id'],rightKeys:['id'],join:'left',cardinality:'one',fields:[{column:'date',as:'new_date'}],rowKey:'key',statusColumn:'id'};await assert.rejects(transformDataset('join_dataset',a,async()=>d),/覆盖/);
});
test('failed import cannot overwrite a corrupted existing copy, and ancestor paths reject symlinks',async t=>{
 const {TaskDatasetStore}=await import('../src/runner/task-dataset-store.js');const root=await mkdtemp(path.join(os.tmpdir(),'reuse-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));const oldDir=path.join(root,'exports','JOB-old');const d=new ReportDatasets({directory:oldDir,scope:'scope',maxRows:'all'});const raw=await d.collect({sql:'SELECT id FROM t ORDER BY id',params:[],columns:['id']},async()=>[[{id:'1'}]]);
 const current=new ReportDatasets({directory:path.join(root,'exports','JOB-current'),scope:'scope',maxRows:'all'});await mkdir(current.storage.root,{recursive:true});await writeFile(path.join(current.storage.root,raw.datasetRef+'.json'),'{}');
 const sources=[{jobId:'JOB-old',datasets:[{datasetRef:raw.datasetRef}]}];await assert.rejects(importReportDataset(current,{sourceJobId:'JOB-old',datasetRef:raw.datasetRef},sources,root),/摘要校验/);
 const {checkedExportDirectory}=await import('../src/runner/report-reuse.js');await symlink(oldDir,path.join(root,'exports','JOB-link'));await assert.rejects(checkedExportDirectory(root,'JOB-link'),/边界/);
 const saved=await d.storage.get(raw.datasetRef);const time=new Date(Date.now()-3*86400000).toISOString();await d.storage.save('dataset-00000000-0000-0000-0000-000000000001',saved.data,saved.snapshotId,time);assert.equal((await d.storage.get('dataset-00000000-0000-0000-0000-000000000001')).readAt,time);
});
test('refresh replays a derived graph deeper than eight steps in one fresh snapshot',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'deep-refresh-'));t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({directory:root,scope:'scope',maxRows:'all'});const statement={sql:'SELECT id FROM examples ORDER BY id',params:[],columns:['id'],recipe:{tool:'row_dataset',args:{table:'examples',columns:['id'],orderBy:['id'],filters:[]}}};
 const raw=await d.collect(statement,async()=>[[{id:'001'},{id:'002'}]]);let ref=raw.datasetRef;
 for(let i=0;i<12;i++)ref=(await d.transform('filter_dataset',{datasetRef:ref,match:'all',filters:[]})).datasetRef;
 const draft=await d.compose({sources:[{name:'s1',datasetRef:ref,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}}]});let begin=0,reloads=0;
 const result=await d.refresh({datasetRef:draft.datasetRef,populationRef:raw.datasetRef,populationKey:'id',requirement:'完整编号清单',scopeEvidence:'同一来源全量核对',expectedColumns:['编号'],columnRules:[{label:'编号',definition:'来源唯一业务编号',evidence:'schema和原问题定义'}],checks:[]},{begin:async()=>{begin++;},reload:async recipe=>{assert.equal(recipe.tool,'row_dataset');reloads++;return d.collect(statement,async()=>[[{id:'001'},{id:'002'}]]);}});
 assert.equal(result.exportFile.rowCount,2);assert.equal(begin,1);assert.equal(reloads,1);
});
test('calendar date comparisons include year-end datetimes without developer-machine timezone conversion',async()=>{
 const d=data([{id:'1',start:'2026-12-31 15:30:00'},{id:'2',start:'2027-01-01 00:00:00'}],['id','start']);const r=await transformDataset('filter_dataset',{datasetRef:'d',match:'all',filters:[{column:'start',type:'date',op:'<=',value:'2026-12-31'}]},async()=>d);assert.deepEqual(r.rows.map(r=>r.id),['1']);
});
test('reuse report inspection only exposes an accepted explicitly linked file and preserves file binding',async t=>{
 const {inspectReusableReport}=await import('../src/runner/report-reuse.js');const root=await mkdtemp(path.join(os.tmpdir(),'reuse-report-'));t.after(()=>rm(root,{recursive:true,force:true}));const base={projectId:'p',chatId:'g',senderId:'u',originProfile:'owner',sourceEnvironment:'prd',taskIntent:'analysis'},first={...base,id:'JOB-parent',questionId:'q1'},next={...base,id:'JOB-child',questionId:'q2'};
 const d=new ReportDatasets({directory:path.join(root,'exports',first.id),scope:'scope',maxRows:'all'});const source=await d.collect({sql:'SELECT id FROM source ORDER BY id',columns:['id'],params:[]},async()=>[[{id:'001'}]]);const draft=await d.compose({sources:[{name:'s1',datasetRef:source.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}}]});const file=(await d.finalize({datasetRef:draft.datasetRef,populationRef:source.datasetRef,populationKey:'id',requirement:'完整编号清单',scopeEvidence:'独立范围字段定义',expectedColumns:['编号'],columnRules:[{label:'编号',definition:'真实唯一业务编号',evidence:'schema字段及业务要求'}],checks:[]})).exportFile;
 first.reportFiles=[file];first.reportReviews={[file.id]:{status:'awaiting_review',verificationHash:file.verificationHash}};const state={jobs:[first,next],questions:{q1:{id:'q1',projectId:'p',chatId:'g',senderId:'u',profile:'owner'},q2:{id:'q2',parentQuestionId:'q1',projectId:'p',chatId:'g',senderId:'u',profile:'owner'}}};const save=()=>writeFile(path.join(root,'agentos.json'),JSON.stringify(state));await save();
 await assert.rejects(inspectReusableReport(root,next,'scope',{sourceJobId:first.id,fileId:file.id}),/已审阅/);
 first.reportReviews[file.id].status='accepted';await save();const info=await inspectReusableReport(root,next,'scope',{sourceJobId:first.id,fileId:file.id});assert.equal(info.binding.fileId,file.id);assert.equal(info.calculationAudit.checkedRows,1);
 await assert.rejects(inspectReusableReport(root,{...next,senderId:'other'},'scope',{sourceJobId:first.id,fileId:file.id}),/已审阅/);
});
