import {isDeepStrictEqual} from 'node:util';
import {reportFile} from './report-files.js';
import {projectReport} from './report-revision.js';
import {documentDirectory,inspectDocumentBytes,writeVerifiedDocument} from './document-artifacts.js';

function fail(message){
 throw Object.assign(new Error(message),{code:'REPORT_INPUT'});
}

async function openWorkbook(bytes){
 const {default:ExcelJS}=await import('exceljs');
 const workbook=new ExcelJS.Workbook();
 await workbook.xlsx.load(bytes);
 return workbook;
}

function worksheetTable(sheet,width){
 const rows=[];
 for(let r=1;r<=sheet.rowCount;r++){
  const row=sheet.getRow(r);
  if(row.cellCount>width)fail('工作表含未登记的额外列');
  const values=[];
  for(let c=1;c<=width;c++){
   const cell=row.getCell(c);
   const value=cell.value;
   if(cell.isMerged||!(value===null||typeof value==='string'||typeof value==='boolean'||Number.isFinite(value))){
    fail('工作表含公式、合并、日期或其它非标量单元格；请使用经核验的值表，不能静默转换');
   }
   values.push(value);
  }
  rows.push(values);
 }
 const [headers,...records]=rows;
 if(!headers||headers.some(h=>typeof h!=='string'||!h.trim())||new Set(headers).size!==headers.length)fail('工作表须有唯一、非空的文本表头');
 return {headers,rows:records};
}

async function projectWorkbook(source,recipe){
 const sheets=source.receipt.contentAudit?.worksheets?.filter(sheet=>sheet.role==='data')??[];
 const {sheetNames,...projection}=recipe;
 const names=sheetNames??(sheets.length===1?[sheets[0].name]:null);
 if(!Array.isArray(names)||!names.length||names.some(name=>typeof name!=='string')||new Set(names).size!==names.length){
  fail('多工作表修订需用 sheetNames 指定实际数据工作表，不能把说明页当作数据');
 }
 const workbook=await openWorkbook(source.content);
 return names.map(name=>{
  const binding=sheets.find(sheet=>sheet.name===name);
  const sheet=workbook.getWorksheet(name);
  if(!binding||!sheet||sheet.state!=='visible'||!Number.isSafeInteger(binding.columnCount)||binding.columnCount<1||sheet.rowCount!==binding.rowCount+1)fail('所选工作表没有匹配的已核验数据范围');
  const input=worksheetTable(sheet,binding.columnCount);
  const output=projectReport(input,projection,{typed:true});
  if(output.rows.some(row=>row.every(value=>value===null)))fail('选列后存在全空数据行，无法与工作簿空行区分；请保留至少一个非空字段');
  return {name,binding,input,output};
 });
}

async function verifyCells(bytes,tables){
 const workbook=await openWorkbook(bytes);
 if(workbook.worksheets.length!==tables.length)fail('生成文件的实际工作表数量不一致');
 for(const [i,{name,output}] of tables.entries()){
  const sheet=workbook.worksheets[i];
  if(sheet.name!==name||!isDeepStrictEqual(worksheetTable(sheet,output.headers.length),{headers:output.headers,rows:output.rows})){
   fail('生成文件的表头、原始单元格或行顺序与修订配方不符');
  }
 }
}

function worksheetProof(tables,sourceJobId,sourceFile){
 return tables.map(({name,binding,output})=>({
  name,role:'data',id:sourceFile.id,sourceJobId,sha256:sourceFile.sha256,verificationHash:sourceFile.verificationHash,
  rowCount:output.rows.length,columnCount:output.headers.length,sourceRowCount:binding.rowCount
 }));
}

async function loadSource(dataDir,sourceJobId,sourceFile,visited){
 const source=await reportFile(dataDir,sourceJobId,sourceFile,{includeReceipt:true});
 if(source.receipt.contentAudit?.structure!=='passed'||source.receipt.contentAudit?.actualCellsVerified!==true){
  fail('工作簿需要已通过实际单元格核验的数据工作表');
 }
 if(source.receipt.workbookRevision)await inspectWorkbookRevision(dataDir,sourceJobId,sourceFile,source,visited);
 return source;
}

export async function reviseWorkbook(dataDir,job,attachmentSource,args){
 const {attachmentId:_,...projection}=args;
 const {sourceJobId,report:sourceFile}=attachmentSource;
 const source=await loadSource(dataDir,sourceJobId,sourceFile,new Set());
 const tables=await projectWorkbook(source,projection);
 const selected=tables.map(t=>t.name);
 const recipe={...projection,sheetNames:selected};
 const {default:ExcelJS}=await import('exceljs');
 const workbook=new ExcelJS.Workbook();
 for(const {name,output} of tables){
  const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
  sheet.addRow(output.headers).font={bold:true};
  sheet.addRows(output.rows);
 }
 const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
 const structure=await inspectDocumentBytes('xlsx',bytes);
 await verifyCells(bytes,tables);
 const worksheets=worksheetProof(tables,sourceJobId,sourceFile);
 const revision={version:1,sourceJobId,sourceFile,recipe};
 const purpose='按原工作簿已核验数据筛选、选列或重排；保留原始单元格值与数据时点。';
 const exportFile=await writeVerifiedDocument(await documentDirectory(dataDir,job.id),job,{
  format:'xlsx',title:(sourceFile.title??'数据工作簿')+'（修订）',purpose,content:{workbookRevision:revision},
 },bytes,{...structure,worksheets,actualCellsVerified:true},{workbookRevision:revision});
 const original=source.receipt.contentAudit.worksheets.filter(s=>s.role==='data').map(s=>s.name);
 return {exportFile,changed:!isDeepStrictEqual(original,selected)||tables.some(({input,output})=>!isDeepStrictEqual(input,{headers:output.headers,rows:output.rows})),
  worksheets,revision,note:'已逐表逐格核对筛选结果。此文件沿用历史工作簿的数据时点；请审阅实际文件后按原任务交付。'};
}

export async function inspectWorkbookRevision(dataDir,sourceJobId,item,file,visited=new Set()){
 const revision=file.receipt.workbookRevision;
 const key=sourceJobId+':'+item.id;
 if(item.format!=='xlsx'||revision?.version!==1||visited.has(key))fail('工作簿修订来源循环或版本无效');
 visited.add(key);
 const source=await loadSource(dataDir,revision.sourceJobId,revision.sourceFile,visited);
 const tables=await projectWorkbook(source,revision.recipe);
 await verifyCells(file.content,tables);
 const worksheets=worksheetProof(tables,revision.sourceJobId,revision.sourceFile);
 if(!isDeepStrictEqual(file.receipt.contentAudit.worksheets,worksheets))fail('工作簿修订的核验记录与实际范围不一致');
 return {revision,calculationAudit:{status:'passed',checkedRows:worksheets.reduce((sum,sheet)=>sum+sheet.rowCount,0)}};
}
