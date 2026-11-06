import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {questionContextIds} from '../src/shared/question-context.js';
import {reportConversationContext} from '../src/shared/report-context.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {reusableReportSources,importReportDataset,inspectReusableReport} from '../src/runner/report-reuse.js';

test('legacy topic anchors recover public ancestry and never infer unrelated or private questions',()=>{
 const base={chatId:'g',projectId:'p',profile:'owner',senderId:'a'};
 const root={...base,id:'q1',messageId:'root'},reply={...base,id:'q2',messageId:'follow',threadRootId:'root',senderId:'b'};
 const state={questions:{q1:root,q2:reply}};
 assert.deepEqual([...questionContextIds(state,{...reply,questionId:'q2'})],['q2','q1']);
 for(const change of [{visibility:'requester'},{chatId:'other'},{profile:'other'},{projectId:'other'}]){
  state.questions.q1={...root,...change};assert.deepEqual([...questionContextIds(state,{...reply,questionId:'q2'})],['q2']);
 }
 state.questions.q1=root;delete reply.threadRootId;
 assert.deepEqual([...questionContextIds(state,{...reply,questionId:'q2'})],['q2']);
});

test('cross-member report reuse includes only delivered public bound sources, preserves time and fails closed',async t=>{
 const root=await mkdtemp('/private/tmp/report-followup-');t.after(()=>rm(root,{recursive:true,force:true}));
 const base={projectId:'p',chatId:'g',originProfile:'owner',sourceEnvironment:'prd',taskIntent:'analysis'};
 const source={...base,id:'JOB-source',questionId:'q1',senderId:'a',status:'completed'},current={...base,id:'JOB-current',questionId:'q2',senderId:'b'};
 const store=new ReportDatasets({directory:path.join(root,'exports',source.id),scope:'scope',maxRows:'all'});
 const raw=await store.collect({sql:'SELECT id,label FROM x ORDER BY id',params:[],columns:['id','label']},async()=>[[{id:'001',label:'部门A'},{id:'002',label:'部门B'}]]);
 const auxiliary=await store.collect({sql:'SELECT id,label FROM extra ORDER BY id',params:[],columns:['id','label']},async()=>[[{id:'private-aux',label:'not-exported'}]]);
 const draft=await store.compose({sources:[{name:'s1',datasetRef:raw.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'field',source:'s1',column:'id'}},{label:'部门',value:{op:'field',source:'s1',column:'label'}}]});
 const file=(await store.finalize({datasetRef:draft.datasetRef,populationRef:raw.datasetRef,populationKey:'id',requirement:'完整部门清单',scopeEvidence:'完整对象一行一对象',expectedColumns:['编号','部门'],columnRules:[{label:'编号',definition:'实际主键',evidence:'schema id'},{label:'部门',definition:'部门名称',evidence:'schema label'}],checks:[]})).exportFile;
 source.reportFiles=[file];source.reportReviews={[file.id]:{status:'accepted',verificationHash:file.verificationHash}};
 const state={jobs:[source,current],questions:{q1:{id:'q1',messageId:'root',projectId:'p',chatId:'g',profile:'owner',senderId:'a'},q2:{id:'q2',messageId:'reply',threadRootId:'root',projectId:'p',chatId:'g',profile:'owner',senderId:'b'}},reportDeliveries:{}};
 const save=()=>writeFile(path.join(root,'agentos.json'),JSON.stringify(state));await save();
 assert.deepEqual(await reusableReportSources(root,current,'scope'),[]);
 state.reportDeliveries[source.id+':'+file.id]={sourceJobId:source.id,item:file,destination:{profile:'owner'},messageId:'sent-file',deliveredAt:new Date().toISOString()};await save();
 let catalog=await reusableReportSources(root,current,'scope');assert.equal(catalog.length,1);
 assert.ok(catalog[0].datasets.some(d=>d.datasetRef===raw.datasetRef));
 assert.ok(!catalog[0].datasets.some(d=>d.datasetRef===auxiliary.datasetRef));
 const next=new ReportDatasets({directory:path.join(root,'exports',current.id),scope:'scope',maxRows:'all'});
 const reused=await importReportDataset(next,{sourceJobId:source.id,datasetRef:raw.datasetRef},catalog,root);
 assert.equal(reused.readAt,raw.readAt);assert.equal(reused.rowCount,2);
 const info=await inspectReusableReport(root,current,'scope',{sourceJobId:source.id,fileId:file.id});assert.equal(info.binding.fileId,file.id);
 const context=await reportConversationContext(root,state,source);assert.equal(context[0].availability,'available');assert.equal(context[0].messageId,'sent-file');
 for(const changed of [{visibility:'requester'},{sourceEnvironment:'uat'},{status:'running'},{chatId:'other'}]){
  Object.assign(source,changed);await save();assert.deepEqual(await reusableReportSources(root,current,'scope'),[]);Object.assign(source,{visibility:undefined,sourceEnvironment:'prd',status:'completed',chatId:'g'});
 }
 await save();assert.deepEqual(await reusableReportSources(root,current,'other-scope'),[]);
 await rm(path.join(root,'exports',source.id,file.filename));
 assert.equal((await reportConversationContext(root,state,source))[0].availability,'unavailable');
 assert.deepEqual(await reusableReportSources(root,current,'scope'),[]);
});
