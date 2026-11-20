import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {datasetDependencies} from '../src/runner/task-dataset-store.js';
import {createDocuments,requestedDocumentFormats} from '../src/shared/document-artifacts.js';

test('same authorized sample survives restart and verified CSV converts to an independently read-back workbook',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'agentos-sample-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const job={id:'JOB-sample',projectId:'demo',originProfile:'demo',questionId:'QST-sample',sourceEnvironment:'sit',tabularDelivery:true};
 const directory=path.join(dataDir,'exports',job.id);
 const options={directory,scope:'demo-sit-scope',maxRows:100,originalQuestion:'随机抽10条，导出 XLSX'};
 const reports = new ReportDatasets(options);
 const rows=Array.from({length:27},(_,i)=>({id:String(i).padStart(4,'0'),code:'00009007199254740993'}));
 const source=await reports.captureRows(rows,['id','code'],{complete:true,queryDefinition:{sql:'SELECT id, code FROM demo',params:[]}});
 const draw=await reports.sample({datasetRef:source.datasetRef,keyColumn:'id',size:10});
 assert.deepEqual(draw.audit,{populationRows:27,sampledRows:10,requestedRows:10,withoutReplacement:true});
 const resumed=new ReportDatasets(options),sample=await resumed.restore(draw.datasetRef);
 assert.equal(new Set(sample.rows.map(r=>r.id)).size,10);
 assert.deepEqual(datasetDependencies(sample),[source.datasetRef]);
 await resumed.verifyDerived(sample);
 await assert.rejects(new ReportDatasets({...options,scope:'other-system-prd'}).restore(draw.datasetRef));
 await assert.rejects(resumed.verifyDerived({...sample,rows:[...sample.rows].reverse()}),/重算不一致/);
 const columns=[{label:'编码',value:{op:'field',source:'s1',column:'code'}}];
 const draft=await resumed.compose({sources:[{name:'s1',datasetRef:draw.datasetRef,keyColumn:'id'}],columns});
 const saved=await resumed.finalize({datasetRef:draft.datasetRef,populationRef:draw.datasetRef,populationKey:'id',
  requirement:'随机抽取十条',scopeEvidence:'演示数据全体共27条',expectedColumns:draft.columns,checks:[],
  columnRules:[{label:'编码',definition:'原始文本编码',evidence:'演示查询定义'}]});
 job.reportFiles=[saved.exportFile];
 const [workbook]=await createDocuments(dataDir,job,[{format:'xlsx',title:'随机样本',purpose:'展示十条随机样本',content:JSON.stringify({sourceReportId:saved.exportFile.id,sheetName:'随机样本'})}]);
 assert.equal(workbook.format,'xlsx');
 assert.deepEqual(requestedDocumentFormats(options.originalQuestion),['xlsx']);
});
