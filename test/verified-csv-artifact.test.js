import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDocuments,documentDirectory} from '../src/shared/document-artifacts.js';
import {prepareArtifactWorkspace} from '../src/shared/artifact-workspace.js';
import {encodeReportCsv} from '../src/shared/report-revision.js';
import {inspectReport} from '../src/shared/report-inspection.js';
import {validateNewCsvArtifact} from '../src/shared/verified-csv-artifact.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const job={id:'target',projectId:'one',chatId:'chat',originProfile:'bot',sourceEnvironment:'prd',tabularDelivery:true};
async function source(dir,jobId,headers,rows){
 const output=await documentDirectory(dir,jobId),id='report-'+randomUUID(),filename=id+'.csv',bytes=encodeReportCsv(headers,rows);
 const item={id,filename,sourceJobId:jobId,rowCount:rows.length,bytes:bytes.length,sha256:sha(bytes),complete:true};
 const receipt=JSON.stringify({version:1,status:'verified',file:item,coverage:{rowCount:item.rowCount}});
 await writeFile(path.join(output,filename),bytes);
 await writeFile(path.join(output,id+'.verification.json'),receipt);
 return {...item,verificationHash:sha(receipt)};
}

test('business CSV artifact replays matching rows from different bound sources and verifies grouped actual content',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aos-artifact-csv-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=await source(dir,'parent',['ID','Value'],[['0001','A'],['0001','B'],['0002','X']]);
 const b=await source(dir,'target',['Code','Name'],[['0001','B'],['0003','C']]);
 const input={...job,reportFiles:[b],attachments:[{source:{kind:'delivered-report',sourceJobId:'parent',report:a,sha256:a.sha256,projectId:job.projectId,chatId:job.chatId,originProfile:job.originProfile,sourceEnvironment:job.sourceEnvironment}}]};
 const {directory}=await prepareArtifactWorkspace(dir,job.id);
 const spec={artifactFile:'grouped.csv',headers:['Identifier','Name'],sources:[
  {fileId:a.id,filters:[{column:'Value',values:['A','B']}],columns:[{from:'ID'},{from:'Value'}]},
  {fileId:b.id,filters:[{column:'Name',values:['B','C']}],columns:[{from:'Code'},{from:'Name'}]}
 ],group:{keys:['Identifier'],collect:'Name',label:'Values',separator:'；'}};
 const request={format:'csv',title:'Grouped data',purpose:'Filter approved sources',content:JSON.stringify(spec)};
 const working=path.join(directory,spec.artifactFile);
 await writeFile(working,encodeReportCsv(['Identifier','Values'],[['0001','A；B']]));
 await assert.rejects(createDocuments(dir,input,[request]),/实际CSV/);
 await writeFile(working,encodeReportCsv(['Identifier','Values'],[['0001','A；B'],['0003','C']]));
 await assert.rejects(createDocuments(dir,{...input,sourceEnvironment:'sit'},[request]),/CSV来源/);
 const [file]=await createDocuments(dir,input,[request]);
 await validateNewCsvArtifact(dir,input,file);
 await assert.rejects(validateNewCsvArtifact(dir,{...input,attachments:[]},file),/CSV来源/);
 const view={...job,reportFiles:[file]};
 assert.equal((await inspectReport(dir,view,{fileId:file.id})).calculationAudit.checkedRows,2);
 const rows=await inspectReport(dir,view,{fileId:file.id,section:'rows',limit:1,columns:['Identifier']});
 assert.deepEqual(rows.items[0].values,['0001']);
 assert.equal(rows.nextOffset,1);
 await rm(working);
 assert.equal((await inspectReport(dir,view,{fileId:file.id})).status,'verified');
 await assert.rejects(createDocuments(dir,input,[{...request,content:{artifactFile:'old.csv',sourceFile:null}}]),error=>error.code==='DOCUMENT_INPUT'&&/业务CSV/.test(error.message)&&!/XLSX/.test(error.message));
});
