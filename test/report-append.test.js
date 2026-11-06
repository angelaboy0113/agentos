import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,readFile,writeFile}from'node:fs/promises';import path from'node:path';import os from'node:os';import{createHash}from'node:crypto';
import{ReportDatasets}from'../src/runner/report-datasets.js';import{createEnvironmentTools}from'../src/runner/environment-tools.js';
import{deliveredCsvDataset,formatReportValue,appendReportColumns,appendReportFile}from'../src/shared/report-append.js';
import{reportCsv,reviseReportFile}from'../src/shared/report-revision.js';import{inspectReport}from'../src/shared/report-inspection.js';import{reportFile}from'../src/shared/report-files.js';import{verifiedFileStepComplete}from'../src/runner/environment-investigator.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const format={kind:'month_compact',inputType:'civil_datetime'};
const recipe={attachmentId:'input',datasetRef:'dataset',leftKey:'编号',rightKey:'id',columns:[{column:'date',label:'期望交货月',format}],missing:'error',nulls:'empty',outside:'error',requirement:'按原文件补充月份，不刷新原列'};
async function fixture(t,projectId='A',profile='bot-A',environment='prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'append-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'exports','JOB-old'),d=new ReportDatasets({maxRows:'all',directory:dir,scope:'original'}),rows=[{id:'00001',note:'9007199254740993.01'},{id:'00002',note:'多行\n"原文"'},{id:'00003',note:''}];
 const s=await d.collect({sql:'SELECT original',params:[],columns:['id','note']},async()=>[rows]);
 const draft=await d.compose({sources:[{name:'s1',datasetRef:s.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'原文',value:{op:'field',source:'s1',column:'note'}}]});
 const f=await d.finalize({datasetRef:draft.datasetRef,requirement:'保留完整原文',scopeEvidence:'三个合成对象',expectedColumns:draft.columns,populationRef:s.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'直接保留原文',evidence:'完整合成数据'})),checks:[]});
 const item={...f.exportFile,sourceJobId:'JOB-old'},bytes=(await reportFile(root,'JOB-old',item)).content;
 const attachment={id:'input',contentType:'text/csv',type:'file',source:{kind:'delivered-report',projectId,originProfile:profile,chatId:'chat',sourceEnvironment:environment,sourceJobId:'JOB-old',report:item,sha256:hash(bytes)}};
 const job={id:'JOB-new',projectId,originProfile:profile,chatId:'chat',sourceEnvironment:environment,attachments:[attachment]};
 return{root,job,attachment,bytes};
}
test('month formatting validates civil dates/times, mixed months, leap years and ambiguity without SQL conversion',()=>{
 for(const v of ['202601',202601,'2026-01','2026-1'])assert.equal(formatReportValue(v,{kind:'month_compact',inputType:'month'}),'202601');
 assert.equal(formatReportValue('2024-02-29 23:59:59.000',format),'202402');assert.equal(formatReportValue('2025-12-31',{kind:'month_compact',inputType:'civil_day'}),'202512');assert.equal(formatReportValue('20260101',{kind:'month_compact',inputType:'civil_day'}),'202601');
 for(const v of ['2026-02-29 00:00:00','2026-13-01 00:00:00','2026-01-01 24:00:00','2026-01-01T00:00:00Z','2026-01-01T00:00:00+08:00',20260101,''])assert.throws(()=>formatReportValue(v,format));
});
test('left append preserves duplicate input rows/order/large text and separately accounts missing/null/outside',()=>{
 const input={headers:['编号','原文'],rows:[['00001','9007199254740993.01'],['00001','same key different grain'],['00002',''],['00003','unknown']]};
 const data={complete:true,columns:['id','date'],rows:[{id:'00002',date:null},{id:'00001',date:'2026-01-31 10:00:00'},{id:'outside',date:'2025-12-01 00:00:00'}]};
 const result=appendReportColumns(input,data,{...recipe,missing:'empty',outside:'exclude'});
 assert.deepEqual(result.rows.map(r=>r.slice(0,-1)),input.rows);assert.deepEqual(result.rows.map(r=>r.at(-1)),['202601','202601','','']);assert.equal(result.audit.unmatchedRows,1);assert.equal(result.audit.nullSourceCells,1);assert.equal(result.audit.excludedSourceRows,1);assert.equal(result.audit.duplicateLeftRows,1);
 const invalid=structuredClone(data);invalid.rows[2].date='2026-13-01 00:00:00';assert.throws(()=>appendReportColumns(input,invalid,{...recipe,missing:'empty',outside:'exclude'}),/日期/);
});
test('invalid joins, duplicate supplemental keys, collisions, unknown parameters and numerical additions cannot silently pass',()=>{
 const input={headers:['编号'],rows:[['1']]},data={complete:true,columns:['id','date'],rows:[{id:'1',date:'2026-01-01 00:00:00'}]};
 for(const d of [{...data,complete:false},{...data,rows:[...data.rows,...data.rows]},{...data,rows:[{id:'',date:'2026-01-01 00:00:00'}]},{...data,rows:[]},{...data,rows:[{id:'outside',date:'2026-01-01 00:00:00'}]}])assert.throws(()=>appendReportColumns(input,d,recipe));
 assert.throws(()=>appendReportColumns(input,data,{...recipe,columns:[{column:'date',label:'编号'}]}));assert.throws(()=>appendReportColumns(input,data,{...recipe,sql:'arbitrary'}));assert.throws(()=>appendReportColumns(input,{...data,numericColumns:['date']},{...recipe,columns:[{column:'date',label:'新增数值'}]}));
});
test('import and append are actually exposed to SQL tools and new-file inspection survives a fresh process store',async t=>{
 const f=await fixture(t),e={kind:'mysql',projectId:'A',tier:'prd',database:'synthetic'},scope=hash(JSON.stringify(e)),directory=path.join(f.root,'exports',f.job.id),d=new ReportDatasets({maxRows:'all',directory,scope});
 const q={mode:'investigate',tables:['orders'],exportMaxRows:'all',maxRows:20,timeoutMs:1000};let reads=0;
 const tools=await createEnvironmentTools(e,q,{}, {dataDir:f.root,exportDirectory:directory,reportJob:f.job,readTaskInput:async()=>{reads++;return f.bytes;},connect:()=>{throw Error('No SQL needed to reshape files');}});t.after(()=>tools.close());
 assert.ok(tools.spec.some(x=>x.tool==='import_task_input'));assert.ok(tools.spec.some(x=>x.tool==='append_report_columns'));
 const imported=await tools.run('import_task_input',{attachmentId:'input',columns:[{index:0,as:'id',type:'string',normalization:'none'}],rowKey:'row'});assert.equal(imported.rowCount,3);const set=await tools.run('collect_dataset_values',{datasetRef:imported.datasetRef,columns:['id'],nulls:'error'});assert.equal(set.count,3);
 const supplemental=await d.collect({sql:'SELECT dates WHERE keys',params:[],columns:['id','date']},async()=>[[{id:'00003',date:'2026-03-02 11:22:33'},{id:'00001',date:'2025-12-31 00:00:00'},{id:'00002',date:null}]]);
 const out=await tools.run('append_report_columns',{...recipe,datasetRef:supplemental.datasetRef});assert.equal(reads,2);assert.equal(out.audit.originalCellsPreserved,6);
 const restored=await inspectReport(f.root,{id:f.job.id,reportFiles:[out.exportFile]},{fileId:out.exportFile.id,section:'rows',limit:20});assert.deepEqual(restored.headers,['编号','原文','期望交货月']);assert.deepEqual(restored.items.map(x=>x.values.at(-1)),['202512','','202603']);assert.equal(restored.calculationAudit.status,'passed');assert.ok(verifiedFileStepComplete('append_report_columns',out));
 const json=JSON.parse(await readFile(path.join(directory,'datasets',supplemental.datasetRef+'.json'),'utf8'));json.data.rows[0].date='2026-04-01 00:00:00';await writeFile(path.join(directory,'datasets',supplemental.datasetRef+'.json'),JSON.stringify(json));await assert.rejects(inspectReport(f.root,{id:f.job.id,reportFiles:[out.exportFile]},{fileId:out.exportFile.id}));
});
test('CSV import validates bindings and keeps BOM, duplicates, empties and leading zeros as exact cells',async t=>{
 const f=await fixture(t),args={attachmentId:'input',columns:[{index:0,as:'id'},{index:1,as:'text'}],rowKey:'row'};
 const data=deliveredCsvDataset(f.attachment,f.bytes,args,f.job);assert.equal(data.rows[0].id,'00001');assert.equal(data.rows[0].text,'9007199254740993.01');assert.equal(data.rows[2].text,'');assert.equal(data.rows.length,3);
 for(const job of [{...f.job,projectId:'B'},{...f.job,originProfile:'bot-B'},{...f.job,chatId:'other'}])assert.throws(()=>deliveredCsvDataset(f.attachment,f.bytes,args,job));
 assert.throws(()=>deliveredCsvDataset(f.attachment,Buffer.from('changed'),args,f.job));assert.throws(()=>deliveredCsvDataset(f.attachment,f.bytes,{...args,columns:[{index:0,as:'id',normalization:'integer_decimal'}]},f.job));
});
test('parallel systems and environments keep supplement stores and immutable original files separate',async t=>{
 await Promise.all([['A','bot-A','prd'],['B','bot-B','sit']].map(async([project,profile,environment])=>{
  const f=await fixture(t,project,profile,environment),d=new ReportDatasets({maxRows:'all',directory:path.join(f.root,'exports',f.job.id),scope:'separate-'+project});
  const captured=await d.collect({sql:'SELECT scoped dates',params:[],columns:['id','date']},async()=>[[{id:'00001',date:'2026-01-01 00:00:00'},{id:'00002',date:null},{id:'00003',date:'2026-03-01 00:00:00'}]]),saved=await d.storage.get(captured.datasetRef);
  const out=await appendReportFile(f.root,f.job,f.attachment,{...recipe,datasetRef:captured.datasetRef},saved);const actual=reportCsv((await reportFile(f.root,f.job.id,out.exportFile)).content);assert.equal(actual.rows.length,3);assert.equal(actual.headers.length,3);assert.deepEqual(actual.rows.map(x=>x.slice(0,2)),reportCsv(f.bytes).rows);
  await assert.rejects(appendReportFile(f.root,{...f.job,sourceEnvironment:environment==='prd'?'sit':'prd'},f.attachment,{...recipe,datasetRef:captured.datasetRef},saved),/环境/);
  if(project==='B'){const mongo=await createEnvironmentTools({kind:'mongodb',projectId:project,tier:'uat',database:'synthetic'},{mode:'investigate',collections:['events'],exportMaxRows:'all',maxRows:20,timeoutMs:1000},{},{dataDir:f.root,exportDirectory:path.join(f.root,'exports',f.job.id),reportJob:f.job,readTaskInput:async()=>f.bytes});try{assert.ok(mongo.spec.some(x=>x.tool==='append_report_columns'));assert.equal((await mongo.run('import_task_input',{attachmentId:'input',columns:[{index:0,as:'id'}]})).rowCount,3);}finally{await mongo.close();}}
 }));
});
test('copying unchanged CSV does not automatically complete a file modification substep',async t=>{
 const f=await fixture(t),out=await reviseReportFile(f.root,f.job,f.attachment,{attachmentId:'input',requirement:'文件修改仍需补充字段'});assert.equal(out.changed,false);assert.equal(verifiedFileStepComplete('revise_report_file',out),false);assert.equal(verifiedFileStepComplete('finalize_report',{}),false);
});
