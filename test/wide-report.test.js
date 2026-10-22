import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {groupedDatasetStatement} from '../src/runner/environment-tools.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {inspectReport} from '../src/shared/report-inspection.js';
test('wide raw-record exports preserve every field and row, with key coverage and exact file recomputation',async t=>{
 for(const width of [40,110]){
 const root=await mkdtemp(path.join(os.tmpdir(),'wide-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const columns=['ID',...Array.from({length:width-1},(_,i)=>'FIELD_'+i)],tables=new Map([['records',columns]]),types=new Map([['records',new Map(columns.map(c=>[c,'varchar']))]]);
 const statement=groupedDatasetStatement({table:'records',groupColumns:columns,aggregates:[{op:'count',as:'source_rows'}],filters:[{column:'ID',op:'>=',value:'1'}]},tables,types,{tables:['*'],maxRows:20});
 assert.ok(statement.batchSize>=5&&statement.batchSize<500);assert.match(statement.sql,/GROUP BY `ID`/);assert.ok(statement.columns.includes('FIELD_'+(width-2)));
 const rows=Array.from({length:17},(_,i)=>Object.fromEntries([...columns.map((c,n)=>[c,n===0?String(i+1):'精确值0000123']),['source_rows','1']]));
 const d=new ReportDatasets({maxRows:'all',directory:path.join(root,'exports','JOB-test'),scope:'wide',originalQuestion:'完整业务表中英文字段导出'});let pages=0;
 const source=await d.collect(statement,async({sql})=>{pages++;const m=sql.match(/LIMIT (\d+) OFFSET (\d+)/);return [rows.slice(+m[2],+m[2]+ +m[1])];});assert.ok(pages>1||statement.batchSize>17);
 const population=await d.collect({sql:'SELECT ID FROM independent_population',params:[],columns:['ID']},async()=>[rows.map(r=>({ID:r.ID}))]);
 const draft=await d.compose({sources:[{name:'s1',datasetRef:source.datasetRef,keyColumn:'ID'}],columns:columns.map((label,i)=>({label,displayName:'字段'+i,value:{op:'field',source:'s1',column:label}}))});assert.equal(draft.columns.length,width);
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'原始对象与所有字段完整导出',scopeEvidence:'实际主键及所需全部字段分组，不增加业务筛选',expectedColumns:draft.columns,columnRules:draft.columns.map(label=>({label,definition:'原始字段逐值保留，不做数值计算',evidence:'对应实体字段注解与实际结构'})),populationRef:population.datasetRef,populationKey:'ID',checks:[]});
 const inspection=await inspectReport(root,{id:'JOB-test',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(inspection.calculationAudit.checkedCells,17*width);assert.equal(inspection.calculationAudit.status,'passed');assert.match(await readFile(path.join(root,'exports','JOB-test',final.exportFile.filename),'utf8'),/精确值0000123/);
 }
});

test('wide paging adapts to response size and retries oversized pages without skipping or duplicating rows',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'adaptive-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const d=new ReportDatasets({maxRows:'all',directory:root,scope:'test'}),rows=Array.from({length:19},(_,i)=>({id:String(i)}));let retries=0;
 const result=await d.collect({sql:'SELECT id FROM records ORDER BY id',params:[],columns:['id'],batchSize:2},async({sql})=>{const m=sql.match(/LIMIT (\d+) OFFSET (\d+)/),size=Number(m[1]),offset=Number(m[2]);if(size>5){retries++;throw Object.assign(new Error('packet size'),{code:'REMOTE_PAGE_TOO_LARGE'});}return [rows.slice(offset,offset+size)];});
 assert.equal(result.complete,true);assert.equal(result.rowCount,19);assert.ok(retries>0);assert.deepEqual((await d.restore(result.datasetRef)).rows,rows);
});
