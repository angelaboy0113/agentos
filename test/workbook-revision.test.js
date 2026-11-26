import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {documentDirectory,inspectDocumentBytes,writeVerifiedDocument} from '../src/shared/document-artifacts.js';
import {reviseReportFile} from '../src/shared/report-revision.js';
import {reportFile} from '../src/shared/report-files.js';
import {inspectReport} from '../src/shared/report-inspection.js';
import {assessReportDelivery,recordReportFiles} from '../src/shared/report-acceptance.js';

const job={id:'output',projectId:'project',questionId:'question',chatId:'chat',originProfile:'bot',sourceEnvironment:'prd',stage:'developer',taskIntent:'analysis',tabularDelivery:true};
const sheetNames=['期初','期末'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const args={attachmentId:'original',requirement:'按对象编号筛选，状态更名',sheetNames,
 filters:[{column:'编号',op:'eq',value:'0007'}],columns:[
  {from:'编号',label:'编号'},{from:'金额',label:'金额'},{from:'状态',label:'原状态'},{from:'有效',label:'有效'}
 ]};

async function fixture(t,{formula=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-workbook-revision-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workbook=new ExcelJS.Workbook();
 const counts=[['期初',null],['期末','9007199254740993.01']];
 for(const [name,amount] of counts){
  const ws=workbook.addWorksheet(name);
  ws.addRows([['编号','金额','状态','有效'],['0007',amount,formula?{formula:'1+1',result:2}:'=原值',true],[7,1.25,'数值编号',false],['008',0,'排除',false]]);
 }
 workbook.addWorksheet('说明').addRow(['备注']);
 const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
 const sourceJob={...job,id:'source'};
 const report=await writeVerifiedDocument(await documentDirectory(root,sourceJob.id),sourceJob,{format:'xlsx',title:'原工作簿',purpose:'合成来源',content:'fixture'},bytes,{
  ...await inspectDocumentBytes('xlsx',bytes),actualCellsVerified:true,
  worksheets:[...sheetNames.map(name=>({name,role:'data',rowCount:3,columnCount:4})),{name:'说明',role:'notes'}]
 });
 const attachment={id:'original',source:{kind:'delivered-report',sourceJobId:sourceJob.id,report,sha256:report.sha256,projectId:job.projectId,chatId:job.chatId,originProfile:job.originProfile,sourceEnvironment:job.sourceEnvironment}};
 return {root,attachment,bytes};
}

test('the authorized revision tool filters workbooks without a DB connection and hands off actual verified XLSX',async t=>{
 const {root,attachment,bytes}=await fixture(t);
 const task={...job,reportFiles:[],attachments:[attachment]};
 const tools=await createEnvironmentTools({kind:'mysql',projectId:job.projectId,tier:'prd',database:'fixture'},
  {mode:'investigate',tables:[],exportMaxRows:'all',maxRows:20,timeoutMs:1000},{},{
   dataDir:root,exportDirectory:path.join(root,'exports',job.id),reportJob:task,
   readTaskInput:async id=>{assert.equal(id,attachment.id);return bytes;},
   connect:()=>assert.fail('file-only revision must not query a database')
 });
 t.after(()=>tools.close());
 assert.ok(tools.spec.some(spec=>spec.tool==='revise_report_file'));
 const revised=await tools.run('revise_report_file',args);
 assert.equal(revised.changed,true);
 assert.equal(revised.exportFile.format,'xlsx');
 const workbook=new ExcelJS.Workbook();
 await workbook.xlsx.load((await reportFile(root,job.id,revised.exportFile)).content);
 assert.deepEqual(workbook.worksheets.map(ws=>ws.name),sheetNames);
 assert.deepEqual(workbook.worksheets.map(ws=>Array.from({length:4},(_,i)=>ws.getRow(2).getCell(i+1).value)),[
  ['0007',null,'=原值',true],['0007','9007199254740993.01','=原值',true]
 ]);
 assert.deepEqual(workbook.worksheets.map(ws=>ws.rowCount),[2,2]);
 assert.deepEqual(await readFile(path.join(root,'exports','source',attachment.source.report.filename)),bytes);
 recordReportFiles(task,[revised.exportFile],1);
 const evidence=await inspectReport(root,task,{fileId:revised.exportFile.id});
 assert.equal(evidence.calculationAudit.checkedRows,2);
 task.reportEvidence=evidence;
 const accepted=assessReportDelivery(task,{outcome:'ready',handoffGate:{passed:true},
  reportAssessment:{fileId:revised.exportFile.id,decision:'deliver',coverage:'complete',issues:[]},
  investigation:{status:'complete',goals:[{id:'original-question',required:true,status:'verified',evidence:'全部指定页和字段已核验'}]}});
 assert.equal(accepted.outcome,'ready');
 const next={...attachment,source:{...attachment.source,sourceJobId:job.id,report:revised.exportFile,sha256:revised.exportFile.sha256}};
 const second=await reviseReportFile(root,{...job,id:'second'},next,{attachmentId:next.id,requirement:'只保留期末',sheetNames:['期末']});
 assert.equal(second.changed,true);
 assert.equal((await inspectReport(root,{id:'second',reportFiles:[second.exportFile]},{fileId:second.exportFile.id})).calculationAudit.checkedRows,1);
 await rm(path.join(root,'exports','source',attachment.source.report.filename));
 await assert.rejects(inspectReport(root,{id:'second',reportFiles:[second.exportFile]},{fileId:second.exportFile.id}),/绑定来源/);
});

test('workbook revisions reject cross-environment inputs, implicit multi-sheet selection, notes, and active formulas',async t=>{
 const {root,attachment}=await fixture(t,{formula:true});
 for(const [task,recipe,diagnostic] of [
  [{...job,sourceEnvironment:'sit'},args,/环境/],
  [{...job,projectId:'other'},args,/项目/],
  [job,{...args,sheetNames:undefined},/指定/],
  [job,{...args,sheetNames:['说明']},/已核验数据范围/],
  [job,args,/公式/]
 ]){
  await assert.rejects(reviseReportFile(root,task,attachment,recipe),error=>error.code==='REPORT_INPUT'&&diagnostic.test(error.message));
 }
});

test('replay detects a changed actual cell even if its file and receipt metadata were updated',async t=>{
 const {root,attachment}=await fixture(t);
 const {exportFile}=await reviseReportFile(root,job,attachment,args);
 const {file,content,receipt}=await reportFile(root,job.id,exportFile,{includeReceipt:true});
 const workbook=new ExcelJS.Workbook();
 await workbook.xlsx.load(content);
 workbook.getWorksheet('期末').getCell('B2').value='0';
 const changed=Buffer.from(await workbook.xlsx.writeBuffer());
 const item={...exportFile,sha256:digest(changed),bytes:changed.length};
 receipt.file={...receipt.file,sha256:item.sha256,bytes:item.bytes};
 const receiptBytes=Buffer.from(JSON.stringify(receipt));
 item.verificationHash=digest(receiptBytes);
 await writeFile(file,changed);
 await writeFile(path.join(path.dirname(file),item.id+'.verification.json'),receiptBytes);
 await assert.rejects(inspectReport(root,{...job,reportFiles:[item]},{fileId:item.id}),/绑定来源/);
});
