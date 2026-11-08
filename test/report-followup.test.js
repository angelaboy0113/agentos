import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {deliveredReportInputs,boundReportInput} from '../src/shared/report-followup.js';
import {reportCsv,projectReport,reviseReportFile} from '../src/shared/report-revision.js';
import {inspectReport,reportReviewEvidence} from '../src/shared/report-inspection.js';
import {recordReportFiles,assessReportDelivery,recordReportReview} from '../src/shared/report-acceptance.js';
import {reportFile} from '../src/shared/report-files.js';
import {downloadAttachments,taskInputNotice} from '../src/runner/codex-executor.js';
import {ReportDelivery} from '../src/control-plane/report-delivery.js';
import {createControlPlane} from '../src/control-plane/server.js';
import {pruneHistory} from '../src/shared/retention.js';

async function fixture(t,projectId='one',profile='bot',environment='prd'){
 const root=await mkdtemp(path.join(os.tmpdir(),'report-followup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id='JOB-original',d=new ReportDatasets({maxRows:'all',directory:path.join(root,'exports',id),scope:'synthetic',originalQuestion:'全部对象金额'});
 const rows=[{id:'00001',amount:'9007199254740993.01',note:'第一行\n"引号"'},{id:'00002',amount:'0.10',note:''},{id:'00003',amount:'0.10',note:'重复金额'}];
 const get=async name=>d.collect({sql:'SELECT '+name,params:[],columns:['id','amount','note'],numericColumns:['amount']},async()=>[rows]);
 const source=await get('detail'),reference=await get('independent');
 const draft=await d.compose({sources:[{name:'s1',datasetRef:source.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'金额',value:{op:'field',source:'s1',column:'amount'}},{label:'说明',value:{op:'field',source:'s1',column:'note'}}]});
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'全部对象金额',expectedColumns:draft.columns,scopeEvidence:'完整合成对象',populationRef:source.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'完整原始值',evidence:'合成来源'})),checks:[{source:'s1',column:'amount',referenceRef:reference.datasetRef,referenceColumn:'amount',evidence:'独立合成聚合'}]});
 const item={...final.exportFile,sourceJobId:id,questionGeneration:1},job={id,projectId,originProfile:profile,chatId:'group',questionId:'q',sourceEnvironment:environment,senderId:'u',status:'completed',instruction:'原文件',reportFiles:[item],reportReviews:{[item.id]:{status:'accepted',verificationHash:item.verificationHash}},result:{outcome:'ready'},taskIntent:'analysis'};
 const state={jobs:[job],questions:{q:{id:'q',projectId,profile,chatId:'group',senderId:'u',generation:1,messageId:'origin'}},reportDeliveries:{[id+':'+item.id]:{sourceJobId:id,item,messageId:'file-delivered',questionId:'q',deliveredAt:'2026-01-02T00:00:00Z'}}};
 const actor={id:'turn',questionId:'q',projectId,profile,chatId:'group',senderId:'u',attachments:[]};
 return {root,state,actor,job,item,rows};
}

test('delivered CSV survives next-generation followup, actual runner download and restart, not just prior reply text',async t=>{
 const f=await fixture(t);f.state.questions.q.generation=2;
 const {inputs}=await deliveredReportInputs(f.state,f.actor,'one',f.root);assert.equal(inputs.length,1);
 const next={...f.job,id:'JOB-followup',reportFiles:[],attachments:inputs};
 const config={serverUrl:'http://controller.invalid',runnerToken:'synthetic'},fetchInput=async()=>new Response(await readFile((await boundReportInput(f.state,next,inputs[0],f.root)).file));
 const files=await downloadAttachments(next,config,path.join(f.root,'runner'),{fetchInput});
 assert.deepEqual(reportCsv(await readFile(files[0].path)).rows.map(r=>r[0]),['00001','00002','00003']);
 assert.match(taskInputNotice(files),/delivered-report|originalDelivery/);
 const restored=await downloadAttachments(JSON.parse(JSON.stringify(next)),config,path.join(f.root,'runner'),{fetchInput:()=>{throw Error('should reuse verified input');}});assert.equal(restored[0].cached,true);
});

test('scope and receipts reject other system, bot, group, unrelated thread and private requester, while public same-thread member can read',async t=>{
 const f=await fixture(t);
 for(const change of [{profile:'other'},{chatId:'other'},{questionId:'unrelated'}])assert.equal((await deliveredReportInputs(f.state,{...f.actor,...change},'one',f.root)).inputs.length,0);
 assert.equal((await deliveredReportInputs(f.state,f.actor,'two',f.root)).inputs.length,0);
 assert.equal((await deliveredReportInputs(f.state,{...f.actor,senderId:'other'},'one',f.root)).inputs.length,1);
 f.job.visibility='requester';f.state.questions.q.visibility='requester';
 assert.equal((await deliveredReportInputs(f.state,{...f.actor,visibility:'requester',senderId:'other'},'one',f.root)).inputs.length,0);
 assert.equal((await deliveredReportInputs(f.state,{...f.actor,visibility:'requester'},'one',f.root)).inputs.length,1);
 delete f.state.reportDeliveries[Object.keys(f.state.reportDeliveries)[0]].messageId;
 assert.equal((await deliveredReportInputs(f.state,{...f.actor,visibility:'requester'},'one',f.root)).inputs.length,0);
});

test('real conversation intake exposes generated files even without any uploaded attachment/history; selected file enters followup job',async t=>{
 const f=await fixture(t),app=await createControlPlane({dataDir:f.root,storeFile:path.join(f.root,'state.json'),projects:{projects:{one:{repoPath:f.root,analysisSourceMode:'isolated',analysisEnvironments:{prd:{repositories:[]}}}},chatProjectMap:{group:'one'}},agents:{agents:{developer:{profile:'bot'}}},feishuClient:{enabled:false},conversationResponder:async()=>{throw Error('no model invoked');}});
 t.after(()=>app.conversations.stop());await app.store.transact(s=>Object.assign(s,f.state,{conversations:[{...f.actor,role:'developer',content:'把上面的文件只保留编号和金额',status:'queued'}]}));
 const turn={...f.actor,role:'developer',content:'把上面的文件只保留编号和金额'};
 const input=await app.conversations.buildInput(turn);assert.equal(input.deliveredFiles.files.length,1);assert.equal(input.attachments.length,1);
 if(process.env.AGENTOS_FOLLOWUP_MODEL_TEST==='1'){
  const {CodexConversationEngine}=await import('../src/control-plane/codex-conversation.js');
  const engine=new CodexConversationEngine({dataDir:path.join(f.root,'model-test')});
  try{const selected=await engine.decide(input,{sessionKey:'synthetic-file-followup'});assert.equal(selected.action,'create_task');assert.equal(selected.intent,'analysis');assert.ok(selected.attachmentIds.includes(input.attachments[0].id));console.log('Real model selected original file: '+JSON.stringify({action:selected.action,intent:selected.intent,attachmentCount:selected.attachmentIds.length,timing:selected.timing}));}finally{await engine.close();}
 }
 const decision={action:'create_task',intent:'analysis',instruction:'读取已交付文件；保留编号和金额',attachmentIds:[input.attachments[0].id],sourceEnvironment:'prd',requiresSourceInspection:false,reply:'',jobId:''};
 const outcome=await app.conversations.apply({...turn,decision,attachmentPool:input.attachments});
 const created=await app.store.getJob(outcome.jobId);assert.equal(created.attachments[0].source.kind,'delivered-report');assert.equal(created.sourceEnvironment,'prd');
});

test('modify actual delivered CSV, independently inspect every output cell, deliver revised version with retry and follow up again',async t=>{
 const f=await fixture(t),attachment=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0];
 const job={...f.job,id:'JOB-revised',stage:'developer',reportFiles:[],reportReviews:{},attachments:[attachment]};
 const tools=await createEnvironmentTools({kind:'mysql',projectId:'one',tier:'prd',database:'synthetic'}, {mode:'investigate',tables:[],exportMaxRows:'all',maxRows:20,timeoutMs:1000}, {}, {dataDir:f.root,exportDirectory:path.join(f.root,'exports',job.id),reportJob:job,readTaskInput:async()=>readFile((await boundReportInput(f.state,job,attachment,f.root)).file),connect:()=>{throw Error('no database query allowed');}});
 t.after(()=>tools.close());assert.ok(tools.spec.some(x=>x.tool==='revise_report_file'));
 const revised=await tools.run('revise_report_file',{attachmentId:attachment.id,requirement:'保留前两列，金额改名为原金额，只要00001',columns:[{from:'编号',label:'编号'},{from:'金额',label:'原金额'}],filters:[{column:'编号',op:'eq',value:'00001'}]});
 recordReportFiles(job,[revised.exportFile],1);job.reportEvidence=await reportReviewEvidence(f.root,job);
 const review=assessReportDelivery(job,{outcome:'ready',summary:'原用户所需两列与指定对象逐格核对通过',handoffGate:{passed:true},reportAssessment:{fileId:revised.exportFile.id,decision:'deliver',coverage:'complete',issues:[]},investigation:{status:'complete',goals:[{id:'original-question',required:true,status:'verified',evidence:'原文件完整读取，按用户选择两列和00001生成新版本'}]}});
 assert.equal(review.outcome,'ready');recordReportReview(job,review);assert.equal(job.reportReviews[revised.exportFile.id].status,'accepted');
 const inspected=await inspectReport(f.root,job,{fileId:revised.exportFile.id,section:'rows',limit:20});assert.deepEqual(inspected.headers,['编号','原金额']);assert.deepEqual(inspected.items[0].values,['00001','9007199254740993.01']);assert.equal(inspected.calculationAudit.status,'passed');
 assert.equal(reportCsv((await reportFile(f.root,f.job.id,f.item)).content).rows.length,3);
 f.state.jobs.push(job);let attempt=0;const keys=[];
 const delivery=new ReportDelivery({store:{read:async()=>structuredClone(f.state),transact:async fn=>fn(f.state)},config:{dataDir:f.root},feishu:{replyFile:async(message,file,options)=>{assert.equal(message,'origin');assert.deepEqual(reportCsv(await readFile(file)).headers,['编号','原金额']);keys.push(options.idempotencyKey);if(!attempt++)throw Error('temporary network');return {data:{message_id:'revised-delivered'}};}}});
 await delivery.enqueue(job);const key=job.id+':'+revised.exportFile.id;f.state.reportDeliveries[key].retryAt=0;await delivery.retry();await delivery.close();assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(f.state.reportDeliveries[key].messageId,'revised-delivered');
 const next=(await deliveredReportInputs(JSON.parse(JSON.stringify(f.state)),f.actor,'one',f.root)).inputs;assert.equal(next.length,2);
 const second=await reviseReportFile(f.root,{...job,id:'JOB-second'},next.at(-1),{attachmentId:next.at(-1).id,requirement:'改标题',columns:[{from:'编号',label:'经销商编号'},{from:'原金额',label:'金额'}]});
 assert.equal((await inspectReport(f.root,{id:'JOB-second',reportFiles:[second.exportFile]},{fileId:second.exportFile.id})).calculationAudit.status,'passed');
});

test('malformed/linked/missing files retain explicit failure; revisions cannot mutate amounts, change environment, use paths or forged references',async t=>{
 const f=await fixture(t),a=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0],job={...f.job,id:'JOB-next',attachments:[a]};
 await assert.rejects(reviseReportFile(f.root,{...job,sourceEnvironment:'sit'},a,{attachmentId:a.id,requirement:'改表头'}),/环境/);
 await assert.rejects(boundReportInput(f.state,job,{...a,source:{...a.source,sourceJobId:'foreign'}},f.root),/不再属于/);
 const parsed=reportCsv((await reportFile(f.root,f.job.id,f.item)).content);
 for(const args of [{requirement:'改值',script:'x'},{requirement:'改值',columns:[{from:'不存在',label:'金额'}]},{requirement:'筛选',filters:[{column:'金额',op:'gt',value:1}]}])assert.throws(()=>projectReport(parsed,args));
 for(const bad of ['"a"x\r\n','"a","a"\r\n','"a"\r\n"broken','"a","b"\r\n"1"\r\n'])assert.throws(()=>reportCsv(Buffer.from(bad)));
 await writeFile(a.path,'corrupt');let state=await deliveredReportInputs(f.state,f.actor,'one',f.root);assert.equal(state.inputs.length,0);assert.equal(state.unavailable.length,1);
 await rm(a.path);await symlink('/etc/hosts',a.path);state=await deliveredReportInputs(f.state,f.actor,'one',f.root);assert.equal(state.inputs.length,0);assert.equal(state.unavailable.length,1);
});

test('parallel projects/environments keep filenames, source evidence and revisions separate',async t=>{
 await Promise.all([['one','bot-one','prd'],['two','bot-two','sit']].map(async ([project,profile,environment])=>{
  const f=await fixture(t,project,profile,environment),a=(await deliveredReportInputs(f.state,f.actor,project,f.root)).inputs[0];
  const revision=await reviseReportFile(f.root,{...f.job,id:'JOB-next'},a,{attachmentId:a.id,requirement:'重排',orderBy:[{column:'编号',direction:'desc'}]});
  const verified=await inspectReport(f.root,{id:'JOB-next',reportFiles:[revision.exportFile]},{fileId:revision.exportFile.id,section:'rows',limit:20});assert.equal(verified.items[0].values[0],'00003');assert.equal(verified.items.length,3);
 }));
});

test('real controller attachment endpoint serves the bound file, enforces runner authentication and rechecks revocation',async t=>{
 const f=await fixture(t),a=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0];
 const app=await createControlPlane({dataDir:f.root,storeFile:path.join(f.root,'http.json'),runnerToken:'synthetic-runner',projects:{projects:{one:{}},chatProjectMap:{}},agents:{agents:{}},feishuClient:{enabled:false},conversationResponder:async()=>{throw Error('no model');}});
 const job={...f.job,id:'JOB-next',attachments:[{...a,path:'/etc/hosts'}]};
 await app.store.transact(s=>Object.assign(s,f.state,{jobs:[f.job,job]}));
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.conversations.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const url='http://127.0.0.1:'+app.server.address().port+'/api/v1/jobs/'+job.id+'/attachments/'+a.id;
 assert.equal((await fetch(url)).status,401);
 const response=await fetch(url,{headers:{authorization:'Bearer synthetic-runner'}});assert.equal(response.status,200);
 assert.deepEqual(reportCsv(Buffer.from(await response.arrayBuffer())).rows.map(r=>r[0]),['00001','00002','00003']);
 await app.store.transact(s=>{s.jobs.find(j=>j.id===job.id).originProfile='foreign';});
 assert.notEqual((await fetch(url,{headers:{authorization:'Bearer synthetic-runner'}})).status,200);
});

test('retention preserves original file evidence while a new task references it, then expires the whole closed dependency graph',async t=>{
 const f=await fixture(t),a=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0],old='2020-01-01T00:00:00Z';
 f.job.createdAt=old;f.job.updatedAt=old;f.state.questions.q.createdAt=old;
 const next={...f.job,id:'JOB-next',questionId:'next',status:'running',attachments:[a],reportFiles:[],createdAt:old,updatedAt:old};
 f.state.jobs.push(next);f.state.questions.next={...f.state.questions.q,id:'next',createdAt:old};
 const cutoff=Date.parse('2026-01-01');assert.equal(pruneHistory(f.state,cutoff).removed.size,0);
 next.status='completed';assert.ok(pruneHistory(f.state,cutoff).removed.has(f.job.id));
});

test('explicit text annotation columns preserve original exact cells, multiline quotes, order and large integer strings',()=>{const input={headers:['编号','金额'],rows:[['0001','9007199254740993.01'],['0002','0.10']]},args={requirement:'末尾新增验收标记，固定文字只读自测',columns:[{from:'编号',label:'编号'},{from:'金额',label:'金额'},{kind:'annotation',label:'验收标记',constant:'只读自测'}]};const out=projectReport(input,args);assert.deepEqual(out.rows.map(r=>r.slice(0,2)),input.rows);assert.deepEqual(out.rows.map(r=>r[2]),['只读自测','只读自测']);assert.deepEqual(input.headers,['编号','金额']);for(const c of [{kind:'annotation',label:'金额',constant:'0'},{kind:'annotation',label:'验收标记',constant:'=1+1'},{kind:'annotation',from:'编号',label:'验收标记',constant:'只读自测'}])assert.throws(()=>projectReport(input,{...args,columns:[c]}));});
test('actual delivered file annotation binds original user literal, version3 replays every cell and no database is needed',async t=>{const f=await fixture(t),attachment=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0],request='原文件所有列保持，末尾新增验收标记，每行填只读自测',job={...f.job,id:'JOB-annotation',originalQuestion:request},args={attachmentId:attachment.id,requirement:request,columns:[...['编号','金额','说明'].map(from=>({from,label:from})),{kind:'annotation',label:'验收标记',constant:'只读自测'}]};const revised=await reviseReportFile(f.root,job,attachment,args);assert.equal(revised.revision.version,3);const checked=await inspectReport(f.root,{id:job.id,reportFiles:[revised.exportFile]},{fileId:revised.exportFile.id});assert.equal(checked.calculationAudit.checkedCells,12);const bytes=await readFile(path.join(f.root,'exports',job.id,revised.exportFile.filename)),csv=reportCsv(bytes);assert.deepEqual(csv.rows.map(r=>r.slice(0,3)),f.rows.map(r=>[r.id,r.amount,r.note]));assert.ok(csv.rows.every(r=>r.at(-1)==='只读自测'));await assert.rejects(reviseReportFile(f.root,{...job,id:'JOB-not-authorized',originalQuestion:'只保留原文件'},attachment,args),/原始用户/);});

test('verified delivered input report permits pending tool continuation, never pretends to be new output or crosses scope',async t=>{const{validateHandoff}=await import('../src/runner/harness.js');const f=await fixture(t),attachment=(await deliveredReportInputs(f.state,f.actor,'one',f.root)).inputs[0],job={...f.job,id:'JOB-input-proof',reportFiles:[],attachments:[attachment],stage:'developer',tabularDelivery:true},result={outcome:'needs_clarification',handoff:{artifacts:[{kind:'report',path:f.item.id}],checks:[{id:'input',required:true,status:'passed',evidence:'实际输入已核验'}],risks:['新文件尚待生成'],returnTo:'none'}};const gate=await validateHandoff(job,result,f.root,{dataDir:f.root});assert.deepEqual(gate.issues,[]);assert.equal(gate.verifiedArtifacts[0].kind,'report-input');assert.ok((await validateHandoff(job,{...result,outcome:'ready'},f.root,{dataDir:f.root})).issues.some(i=>i.includes('仅是输入')));for(const change of [{projectId:'other'},{originProfile:'other'},{sourceEnvironment:'uat'},{chatId:'other'}])assert.ok((await validateHandoff({...job,...change},result,f.root,{dataDir:f.root})).issues.length);});
test('annotation-only operation defaults to appending after all original columns, not projecting them away',()=>{const input={headers:['客户','金额'],rows:[['001','9007199254740993.01']]},args={requirement:'追加验收标记只读自测',annotations:[{label:'验收标记',constant:'只读自测'}]};const out=projectReport(input,args);assert.deepEqual(out.headers,['客户','金额','验收标记']);assert.deepEqual(out.rows,[['001','9007199254740993.01','只读自测']]);assert.deepEqual(projectReport(input,out.recipe),out);});
