import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {summarizeDataset} from '../src/shared/dataset-summary.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {inspectReport} from '../src/shared/report-inspection.js';
import {inquiryExecutionContract} from '../src/shared/inquiry-execution.js';
const data=rows=>({rows,columns:Object.keys(rows[0]),complete:true,numericColumns:[],readAt:'2026-01-01T00:00:00Z',snapshotId:'synthetic'});
const collect={op:'collect_text',column:'label',as:'labels',format:'join',separator:'; ',distinct:true,order:'source',nulls:'exclude'};
test('one-to-many text collection keeps composite scope, explicit order, null and duplicate audit',()=>{
 const d=data([{tenant:'a',id:'001',label:'Review'},{tenant:'a',id:'001',label:'Admin'},{tenant:'a',id:'001',label:'Review'},{tenant:'b',id:'001',label:null}]);
 const a={groupColumns:['tenant','id'],aggregates:[collect]},out=summarizeDataset(a,d);
 assert.deepEqual(out.rows.map(r=>r.labels),['Review; Admin',null]);assert.deepEqual(out.numericColumns,[]);assert.equal(out.derivation.version,2);
 assert.deepEqual(out.derivation.audit.textColumns,[{column:'labels',groups:2,inputRows:4,nulls:1,emptyStrings:0,emittedValues:2,duplicatesRemoved:1,emptyGroups:1}]);
 assert.equal(summarizeDataset({...a,aggregates:[{...collect,order:'asc'}]},d).rows[0].labels,'Admin; Review');
 assert.equal(summarizeDataset({...a,aggregates:[{...collect,distinct:false}]},d).rows[0].labels,'Review; Admin; Review');
});
test('JSON collection preserves real null, empty string, literal null and delimiter-containing labels distinctly',()=>{
 const d=data([{id:'a',label:null},{id:'a',label:''},{id:'a',label:'null'},{id:'a',label:'x; y'}]);
 const out=summarizeDataset({groupColumns:['id'],aggregates:[{...collect,format:'json',nulls:'preserve'}]},d);
 assert.deepEqual(JSON.parse(out.rows[0].labels),[null,'','null','x; y']);
 for(const a of [{...collect,nulls:'error'},{...collect,nulls:'preserve'},{...collect,distinct:undefined},{...collect,separator:''}])assert.throws(()=>summarizeDataset({groupColumns:['id'],aggregates:[a]},d),e=>e.code==='REPORT_INPUT');
});
test('numeric values, missing fields and monetary relabeling cannot bypass independent amount verification',()=>{
 for(const d of [data([{id:'a',label:42}]),{...data([{id:'a',label:'12.00'}]),numericColumns:['label']},{...data([{id:'a',label:'first'}]),rows:[{id:'a'}]}])assert.throws(()=>summarizeDataset({groupColumns:['id'],aggregates:[collect]},d),e=>e.code==='REPORT_INPUT');
 const old=summarizeDataset({groupColumns:['id'],aggregates:[{op:'sum',column:'amount',as:'amount',nulls:'error'}]},data([{id:'a',amount:'9007199254740993.01'},{id:'a',amount:'0.09'}]));
 assert.equal(old.derivation.version,1);assert.equal(old.rows[0].amount,'9007199254740993.1');assert.deepEqual(old.numericColumns,['amount']);
});
async function fixture(t,scope='synthetic-a/prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'list-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'exports','JOB-test'),d=new ReportDatasets({directory,scope,maxRows:'all'});
 const parents=data([{ID:'001',CODE:'00001',NAME:'Parent A'},{ID:'002',CODE:'00002',NAME:'Parent B'},{ID:'003',CODE:'00003',NAME:'Parent C'}]);
 const labels=data([{RID:'r1',PID:'001',LABEL:'Admin'},{RID:'r2',PID:'001',LABEL:'Review'},{RID:'r3',PID:'001',LABEL:'Admin'}]);
 const query=async(value,table)=>d.collect({sql:'SELECT synthetic_'+table+' ORDER BY ID',params:[],columns:value.columns,recipe:{tool:'group_dataset',args:{table}}},async()=>[value.rows]);
 const p=await query(parents,'parents'),l=await query(labels,'labels'),population=await query(parents,'independent_parents');
 const related=await d.relate({datasetRef:p.datasetRef,keyColumns:['ID'],scopeEvidence:'Synthetic complete parent scope; unlinked parents retained',joins:[{datasetRef:l.datasetRef,leftKeys:['ID'],rightKeys:['PID'],rightRowKey:['RID'],relationship:'expand',fields:[{column:'LABEL',as:'label'}],empty:'keep',unmatched:'keep'}]});
 const summary=await d.summarize({datasetRef:related.datasetRef,groupColumns:['ID','CODE','NAME'],aggregates:[collect]});
 const columns=[{label:'Code',value:{op:'field',source:'s1',column:'CODE'}},{label:'Name',value:{op:'field',source:'s1',column:'NAME'}},{label:'Labels',value:{op:'field',source:'s1',column:'labels',missing:'empty'}}];
 const draft=await d.compose({sources:[{name:'s1',datasetRef:summary.datasetRef,keyColumn:'ID'}],columns});
 const finalArgs={datasetRef:draft.datasetRef,requirement:'One complete list with code, name and labels',expectedColumns:draft.columns,scopeEvidence:'Complete independent original parent population; preserve unmatched null labels',populationRef:population.datasetRef,populationKey:'ID',checks:[],columnRules:draft.columns.map(label=>({label,definition:'Synthetic explicit parent field or distinct display labels; null is unknown/unmatched, not zero',evidence:'Synthetic source and complete actual relationship identities'}))};
 return{root,directory,d,parents,labels,summary,draft,finalArgs,scope};
}
test('single complete CSV preserves unmatched parents, all attributes, leading zeros, restore and actual file verification',async t=>{
 const f=await fixture(t),restored=new ReportDatasets({directory:f.directory,scope:f.scope,maxRows:'all'}),saved=await restored.restore(f.summary.datasetRef);await restored.verifyDerived(saved);
 const final=await restored.finalize(f.finalArgs);assert.equal(final.exportFile.rowCount,3);
 const body=await readFile(path.join(f.directory,final.exportFile.filename),'utf8');assert.match(body,/"00001","Parent A","Admin; Review"/);assert.match(body,/"00002","Parent B",""/);assert.match(body,/"00003","Parent C",""/);
 const report=await inspectReport(f.root,{id:'JOB-test',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(report.calculationAudit.status,'passed');assert.equal(report.calculationAudit.checkedCells,9);
 saved.rows[0].labels='tampered';await assert.rejects(restored.verifyDerived(saved));
});
test('refresh rebuilds complete text grouping from each source once and forbids other system or environment references',async t=>{
 const f=await fixture(t);let reads=0;
 const final=await f.d.refresh(f.finalArgs,{begin:async()=>{},reload:async recipe=>{reads++;const v=recipe.args.table==='labels'?f.labels:f.parents;return f.d.collect({sql:'SELECT fresh_'+recipe.args.table,params:[],columns:v.columns,recipe},async()=>[v.rows]);}});
 assert.equal(reads,3);assert.equal(final.exportFile.rowCount,3);
 await assert.rejects(new ReportDatasets({directory:f.directory,scope:'synthetic-b/sit',maxRows:'all'}).restore(f.summary.datasetRef));
});
test('large text collection records bounded per-column audit rather than every parent row',()=>{
 const d=data(Array.from({length:15000},(_,i)=>({id:String(i),label:'Label'})));const out=summarizeDataset({groupColumns:['id'],aggregates:[collect]},d);
 assert.equal(out.rows.length,15000);assert.equal(out.derivation.audit.textColumns.length,1);assert.ok(JSON.stringify(out.derivation.audit).length<400);
});
test('request delivery contract keeps requested fields together without inventing unnamed populations',()=>{
 const c=inquiryExecutionContract({originalQuestion:'Export active members with identifiers, names and roles'});assert.equal(c.listDelivery.version,1);assert.match(c.listDelivery.policy,/主表直接包含所有字段/);assert.match(c.listDelivery.policy,/不把所有同名账号类别/);
});
test('saved text grouping is available through both database tool catalogs and scope revocation stops reuse',async t=>{
 const{createHash}=await import('node:crypto'),{createEnvironmentTools}=await import('../src/runner/environment-tools.js');
 await Promise.all(['prd','sit'].map(async(tier,i)=>{const e={kind:i?'mongodb':'mysql',host:'synthetic-'+i,database:'synthetic',port:i?27017:3306},scope=createHash('sha256').update(JSON.stringify(e)).digest('hex'),f=await fixture(t,scope);let allowed=true;
 const tools=await createEnvironmentTools(e,{tables:['*'],maxRows:20,exportMaxRows:'all',timeoutMs:1000},{username:'synthetic',password:'no-live-access'},{exportDirectory:f.directory,authorize:async()=>{if(!allowed)throw Error('revoked');},mysql:{createConnection:async()=>{throw Error('NO LIVE DATABASE');}}});
 try{assert.match(JSON.stringify(tools.spec.find(s=>s.tool==='summarize_dataset')),/collect_text/);const saved=await f.d.restore(f.summary.datasetRef);const out=await tools.run('summarize_dataset',saved.derivation.args);assert.equal(out.rowCount,3);allowed=false;await assert.rejects(tools.run('summarize_dataset',saved.derivation.args));}finally{await tools.close();}
 }));
});
