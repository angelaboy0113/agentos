import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {readableHeadersRequired} from '../src/shared/report-headers.js';
import {inspectReport} from '../src/shared/report-inspection.js';

test('Chinese business exports require readable headers; only explicit original/English requests opt out',()=>{
 for(const q of ['帮我导出订单','导出库存，不要英文表头','英文列名看不懂，给我中文','导出客户英文名称','表头都是英文，看不懂，改中文'])assert.equal(readableHeadersRequired(q),true,q);
 for(const q of ['导出订单，表头保留原始字段名','请用英文表头导出库存','Export orders'])assert.equal(readableHeadersRequired(q),false,q);
});
test('generic bilingual exports preserve raw identifiers, values and independent formula/coverage verification',async t=>{
 for(const kind of ['orders','inventory']){
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-headers-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const d=new ReportDatasets({maxRows:100,directory:path.join(root,'exports','JOB-test'),scope:'test',originalQuestion:'请导出完整业务清单'});
 const raw=await d.collect({sql:'SELECT ID FROM '+kind,params:[],columns:['ID']},async()=>[[{ID:'00012345678901234567'}]]);
 const args={sources:[{name:'s1',datasetRef:raw.datasetRef,keyColumn:'ID'}],columns:[{label:'ID',value:{op:'key'}}]};
 await assert.rejects(d.compose(args),e=>e.code==='REPORT_INPUT'&&/中文/.test(e.message));
 await assert.rejects(d.compose({...args,columns:[{displayName:'业务编号',value:{op:'key'}}]}),/label/);
 const draft=await d.compose({...args,columns:[{...args.columns[0],displayName:'业务编号'}]});
 assert.deepEqual(draft.columns,['业务编号（ID）']);
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'全部业务编号完整清单',scopeEvidence:'业务实体主键字段全集',expectedColumns:draft.columns,columnRules:[{label:draft.columns[0],definition:'业务实体的原始主键',evidence:'实体注解ID为业务编号'}],populationRef:raw.datasetRef,populationKey:'ID',checks:[]});
 assert.equal(final.coverage.rowCount,1);
 const actual=await readFile(path.join(root,'exports','JOB-test',final.exportFile.filename),'utf8');assert.match(actual,/业务编号（ID）/);assert.match(actual,/00012345678901234567/);
 const inspected=await inspectReport(root,{id:'JOB-test',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(inspected.calculationAudit.status,'passed');
 // Old raw drafts must also pass the current header rule at finalization, not just at composition.
 d.originalQuestion='Export original fields';const legacy=await d.compose(args);d.originalQuestion='中文业务导出';
 await assert.rejects(d.finalize({datasetRef:legacy.datasetRef,requirement:'业务原始编号完整清单',scopeEvidence:'实体主键完整对象范围',expectedColumns:['ID'],columnRules:[{label:'ID',definition:'实体原始业务编号',evidence:'业务实体ID注解定义'}],populationRef:raw.datasetRef,populationKey:'ID',checks:[]}),/中文/);
 }
});
