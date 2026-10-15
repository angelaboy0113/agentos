import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {reportFile,validateReportFiles} from '../src/shared/report-files.js';
const field=(source,column)=>({op:'field',source,column,missing:'zero'});
async function fixture(t,kind='customer'){
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-final-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'exports','JOB-test'),d=new ReportDatasets({maxRows:100,directory,scope:'same-env'});
 const collect=(sql,rows,columns=['id','amount'],numericColumns=['amount'])=>d.collect({sql,params:[],columns,numericColumns},async()=>[rows]);
 const population=await collect('SELECT id,name FROM '+kind,[{id:'1',name:'甲'},{id:'2',name:'乙'}],['id','name'],[]);
 const amounts=await collect('SELECT id,SUM(amount) FROM '+kind,[{id:'1',amount:'0.1'},{id:'2',amount:'0.2'}]);
 const baseline=await collect('SELECT month,SUM(amount) FROM '+kind,[{id:'month',amount:'0.3'}]);
 const columns=[{label:'编号',value:{op:'key'}},{label:'名称',value:{op:'field',source:'s2',column:'name'}},{label:'金额',value:field('s1','amount')}];
 const compose=ref=>d.compose({sources:[{name:'s1',datasetRef:ref,keyColumn:'id'},{name:'s2',datasetRef:population.datasetRef,keyColumn:'id'}],columns});
 const draft=await compose(amounts.datasetRef);
 const args={datasetRef:draft.datasetRef,requirement:'按原问题导出全部对象三列清单',expectedColumns:draft.columns,scopeEvidence:'当前年度有效业务对象全集，依据业务说明',populationRef:population.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'该列的真实业务定义',evidence:'仓库业务定义文档对应小节'})),checks:[{source:'s1',column:'amount',referenceRef:baseline.datasetRef,referenceColumn:'amount',evidence:'同年度同状态按月份独立汇总'}]};
 return {root,d,collect,population,amounts,baseline,draft,args,compose};
}
test('drafts are not deliverables; generic customer and inventory reports require coverage and independent exact totals',async t=>{
 for(const kind of ['customer','inventory']){
  const f=await fixture(t,kind);assert.equal(f.draft.exportFile,undefined);
  await assert.rejects(reportFile(f.root,'JOB-test',f.draft.draftFile),/最终核验/);
  await assert.rejects(f.d.finalize({...f.args,checks:[]}),/每个来源分量/); // Numeric metadata, no total flag loophole.
  const final=await f.d.finalize(f.args);assert.equal(final.coverage.rowCount,2);assert.equal(final.totals[0].total,'0.3');
  assert.equal((await validateReportFiles(f.root,'JOB-test',[final.exportFile]))[0].verificationHash,final.exportFile.verificationHash);
  await assert.rejects(f.d.finalize(f.args),/已定稿/);
  const receipt=path.join(f.root,'exports','JOB-test',final.exportFile.id+'.verification.json');
  const body=JSON.parse(await readFile(receipt,'utf8'));assert.equal(body.columnRules.length,3);body.coverage.rowCount=1;await writeFile(receipt,JSON.stringify(body));
  await assert.rejects(reportFile(f.root,'JOB-test',final.exportFile),/记录摘要/);
 }
});
test('missing columns, sample-only population and self-reconciliation cannot pass',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.d.finalize({...f.args,expectedColumns:['编号','金额']}),/缺列/);
 const sample=await f.collect('SELECT id FROM sample',[{id:'1'}],['id'],[]);
 const one=await f.d.compose({sources:[{name:'s1',datasetRef:sample.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}}]});
 const args={...f.args,datasetRef:one.datasetRef,expectedColumns:['编号'],columnRules:[f.args.columnRules[0]],checks:[]};
 await assert.rejects(f.d.finalize(args),/遗漏1个/);
 await assert.rejects(f.d.finalize({...f.args,populationRef:f.draft.datasetRef,populationKey:'编号'}),/独立原始/);
 await assert.rejects(f.d.finalize({...f.args,checks:[{...f.args.checks[0],referenceRef:f.amounts.datasetRef}]}),/同一查询/);
});
test('wrong-scope totals and stale sources stop export rather than delivering a seemingly complete CSV',async t=>{
 const f=await fixture(t),wrong=await f.collect('SELECT SUM(amount) FROM wrong_scope',[{id:'year',amount:'0.4'}]);
 await assert.rejects(f.d.finalize({...f.args,checks:[{...f.args.checks[0],referenceRef:wrong.datasetRef}]}),/合计不一致/);
 const old=await f.d.restore(f.amounts.datasetRef);old.readAt=new Date(Date.now()-301000).toISOString();
 await assert.rejects(f.d.finalize(f.args),/超过5分钟/);
});
test('durable query provenance, draft formulas and finalization survive a new authorized round',async t=>{
 const f=await fixture(t);f.d.clear();const next=new ReportDatasets({maxRows:100,directory:path.join(f.root,'exports','JOB-test'),scope:'same-env'});
 const catalog=await next.list();assert.ok(catalog.datasets.some(d=>d.kind==='report_draft'));
 const inspected=await next.inspect({datasetRef:f.amounts.datasetRef});assert.match(inspected.queryDefinition.sql,/SUM/);
 const final=await next.finalize(f.args);assert.equal(final.coverage.rowCount,2);
 let allowed=false;const revoked=new ReportDatasets({maxRows:100,directory:path.join(f.root,'exports','JOB-test'),scope:'same-env',authorize:async()=>{if(!allowed)throw new Error('revoked');}});
 await assert.rejects(revoked.finalize(f.args),/revoked/);
});
test('the observed narrow project-name amount cannot pass reconciliation against base-table business totals',async t=>{
 const f=await fixture(t),narrow=await f.collect('SELECT id,SUM(amount) FROM projects WHERE name LIKE ?',[{id:'1',amount:'49872.50'},{id:'2',amount:'0'}]);
 const base=await f.collect('SELECT month,SUM(amount) FROM business_base',[{id:'month',amount:'148228.47'}]);
 const draft=await f.compose(narrow.datasetRef);
 await assert.rejects(f.d.finalize({...f.args,datasetRef:draft.datasetRef,checks:[{...f.args.checks[0],referenceRef:base.datasetRef}]}),/49872.5.*148228.47/);
});
test('multi-source reconciliation is not blocked by the old twelve-reference ceiling; memory byte budget remains enforced',async t=>{
 const f=await fixture(t);
 for(let i=0;i<10;i++)await f.collect('SELECT source'+i,[{id:'1',amount:'0'}]);
 assert.equal(f.d.datasets.size,13);
 const final=await f.d.finalize(f.args);assert.equal(final.coverage.rowCount,2);
 const old=await f.d.restore(f.baseline.datasetRef);delete old.queryDefinition;
 const second=await f.compose(f.amounts.datasetRef);
 await assert.rejects(f.d.finalize({...f.args,datasetRef:second.datasetRef}),/原始查询/);
 f.d.bytes=16_000_000;await assert.rejects(f.collect('SELECT too_many_bytes',[{id:'1',amount:'1'}]),/16MB/);
});
test('six-column balance reports finalize both formulas and per-object minimum without floating-point loss',async t=>{
 const f=await fixture(t),columns=['id','earned','adjustA','adjustB','usedA','usedB'];
 const components=await f.collect('SELECT id, business_components FROM source',[{id:'1',earned:'148228.47',adjustA:'1000',adjustB:'-500',usedA:'43318.69',usedB:'35964'},{id:'2',earned:'0',adjustA:'0',adjustB:'0',usedA:'0',usedB:'0'}],columns,columns.slice(1));
 const baseline=await f.collect('SELECT year, SUM(business_components) FROM source',[{id:'2026',earned:'148228.47',adjustA:'1000',adjustB:'-500',usedA:'43318.69',usedB:'35964'}],columns,columns.slice(1));
 const metadata=await f.collect('SELECT id,area,region FROM org',[{id:'1',area:'一区',region:'一大区'},{id:'2',area:'二区',region:'二大区'}],['id','area','region'],[]);
 const balance=adjust=>({op:'subtract',args:[{op:'add',args:[field('s1','earned'),field('s1',adjust==='adjustA'?'adjustA':'adjustB')]},field('s1',adjust==='adjustA'?'usedA':'usedB')]});
 const outputColumns=[{label:'对象',value:{op:'key'}},{label:'营业区',value:field('s2','area')},{label:'大区',value:field('s2','region')},{label:'申请结余',value:balance('adjustA')},{label:'核销结余',value:balance('adjustB')},{label:'初始化金额',value:{op:'min',args:[balance('adjustA'),balance('adjustB')]}}];
 const draft=await f.d.compose({sources:[{name:'s1',datasetRef:components.datasetRef,keyColumn:'id'},{name:'s2',datasetRef:metadata.datasetRef,keyColumn:'id'}],columns:outputColumns});
 assert.equal(draft.preview[0][3],'105909.78');assert.equal(draft.preview[0][4],'111764.47');assert.equal(draft.preview[0][5],'105909.78');
 const final=await f.d.finalize({...f.args,datasetRef:draft.datasetRef,expectedColumns:draft.columns,columnRules:draft.columns.map(label=>({label,definition:'已核实期间、状态和计算公式',evidence:'对应业务源码和组织映射规则'})),checks:columns.slice(1).map(column=>({source:'s1',column,referenceRef:baseline.datasetRef,referenceColumn:column,evidence:'同范围按年度独立汇总各分量'}))});
 assert.equal(final.totals.length,5);assert.equal(final.coverage.rowCount,2);
});

test('coverage uses internal business IDs without adding an unwanted ID column to the user file',async t=>{
 const f=await fixture(t);const draft=await f.d.compose({sources:[{name:'s1',datasetRef:f.population.datasetRef,keyColumn:'id'}],columns:[{label:'名称',value:{op:'field',source:'s1',column:'name'}}]});
 const final=await f.d.finalize({...f.args,datasetRef:draft.datasetRef,expectedColumns:['名称'],columnRules:[{label:'名称',definition:'业务对象的显示名称',evidence:'对象主数据名称字段'}],checks:[]});
 const file=await reportFile(f.root,'JOB-test',final.exportFile);assert.equal(file.content.toString().split('\r\n')[0],'\uFEFF"名称"');assert.equal(final.coverage.rowCount,2);
});
