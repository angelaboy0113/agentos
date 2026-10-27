import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';

test('long-field evidence survives restart, nulls and paging without upgrading a partial query',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'long-evidence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const text='规则😀,\n'.repeat(6000),first=new ReportDatasets({directory:root,scope:'system-a:uat'});
 const out=await first.captureRows([{id:'one',text,empty:null}],['id','text','empty'],{complete:false,queryDefinition:{sql:'SELECT fixed',params:[]}});
 const next=new ReportDatasets({directory:root,scope:'system-a:uat'});let value='',offset=0;
 do{const part=await next.readDataset({datasetRef:out.evidenceRef,column:'text',textOffset:offset,limit:3999});value+=part.value;offset=part.nextTextOffset;assert.equal(part.complete,false);assert.equal(part.readAt,out.readAt);}while(offset!==null);
 assert.equal(value,text);assert.equal((await next.readDataset({datasetRef:out.evidenceRef,column:'empty'})).value,null);
 assert.equal((await next.list()).datasets.length,0);await assert.rejects(next.restore(out.evidenceRef),/校验失败/);
 await assert.rejects(new ReportDatasets({directory:root,scope:'system-b:prd'}).readDataset({datasetRef:out.evidenceRef,column:'text'}),/范围/);
});
test('ordinary non-export queries expose durable field paging, with no repeat database query',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'long-query-'));t.after(()=>rm(root,{recursive:true,force:true}));let businessReads=0;
 const text='完整规则'.repeat(7000);
 const mysql={createConnection:async()=>({query:async sql=>sql.startsWith('SHOW GRANTS')?[[{Grants:'GRANT SELECT ON `demo`.* TO test'}]]:[[]],execute:async s=>{
 if(s.sql.includes('information_schema.COLUMNS'))return [[{table_name:'rules',column_name:'id',data_type:'varchar',engine:'InnoDB'},{table_name:'rules',column_name:'text',data_type:'text',engine:'InnoDB'}]];
 businessReads++;return [[{id:'one',text}]];
 },rollback:async()=>{},destroy(){}})};
 const tools=await createEnvironmentTools({kind:'mysql',host:'synthetic',database:'demo'},{tables:['rules'],maxRows:5,timeoutMs:3000},{username:'fake',password:'secret-synthetic'},{mysql,exportDirectory:root});t.after(()=>tools.close());
 assert.ok(tools.spec.some(x=>x.tool==='read_dataset'));await tools.run('schema',{table:'rules'});
 const out=await tools.run('select',{table:'rules',columns:['id','text'],filters:[{column:'id',op:'=',value:'one'}]});
 assert.ok(out.evidenceRef);const part=await tools.run('read_dataset',{datasetRef:out.evidenceRef,column:'text',textOffset:text.length-4});assert.equal(part.value,'完整规则');assert.equal(businessReads,1);
});
