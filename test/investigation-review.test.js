import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {assessInvestigation,causalEvidenceComplete,investigationComplete,requiresCausalEvidence,reviewDecision,QUESTION_GOAL_ID} from '../src/shared/investigation-review.js';
import {preserveAnalysisGaps} from '../src/runner/harness.js';
const review=()=>({status:'continue',goals:[{id:'actual-data',status:'open',evidence:'Source checked; database not checked'}],attempts:['Checked source and environment catalog'],nextStep:'Find matching Nacos configuration',blocker:null});
const result=()=>({outcome:'partial',summary:'Still checking',finalMessage:'Evidence',investigation:review(),handoff:{artifacts:[{kind:'code',path:'a.js'}],checks:[],risks:['Database not checked']},verifiedArtifacts:[{path:'a.js'}],handoffGate:{passed:true},sourceSync:{repositories:[{commit:'abc'}]}});
test('completion requires all declared goals with evidence; old resolved gaps can close',()=>{
 const prior=result(), job={taskIntent:'analysis',stage:'owner_report',context:[{stage:'developer',result:prior}]};
 const r=result();r.outcome='ready';r.investigation.status='complete';r.investigation.goals[0]={id:'actual-data',status:'verified',evidence:'Read-only query evidence from current UAT plan'};
 assert.equal(investigationComplete(job,r),true);
 assert.equal(preserveAnalysisGaps(job,r).outcome,'ready');
 assert.equal(assessInvestigation(job,r).outcome,'ready');
 r.investigation.goals[0].id='different';assert.equal(assessInvestigation(job,r).outcome,'partial');
 r.investigation=null;assert.equal(assessInvestigation(job,r).outcome,'partial');
 assert.equal(assessInvestigation({...job,taskIntent:'implementation'},r).outcome,'ready');
});
test('optional adjacent findings cannot keep an answered user question red',()=>{
 const job={taskIntent:'analysis',stage:'developer',context:[]};
 const r=result();r.outcome='ready';r.investigation={...r.investigation,status:'complete',goals:[
  {id:'asked-field-limit',required:true,status:'verified',evidence:'Frontend and backend both enforce 150 characters'},
  {id:'adjacent-srm-column',required:false,status:'open',evidence:'Screenshot contains a separate SRM mapping error'},
 ],blocker:null};
 assert.equal(investigationComplete(job,r),true);
 assert.equal(assessInvestigation(job,r).outcome,'ready');
});
test('new supporting fields cannot become acceptance gates after original question is answered',()=>{
 const job={taskIntent:'analysis',stage:'owner_report',context:[{result:{outcome:'partial',investigation:{goals:[
  {id:QUESTION_GOAL_ID,required:true,status:'open',evidence:'Calculation still being checked'},
  {id:'direct-price-field',required:true,status:'open',evidence:'Intermediate price field not located'},
 ]}}}]};
 const r={outcome:'partial',summary:'Formula and actual deductions match',finalMessage:'The deduction is 130.',investigation:{status:'continue',blocker:null,goals:[
  {id:QUESTION_GOAL_ID,required:true,status:'verified',evidence:'Source formula and persisted deductions reproduce 260-32.5-130=97.5'},
  {id:'direct-price-field',required:true,status:'open',evidence:''},
 ],attempts:['Checked source and actual records'],nextStep:'Find intermediate field'},handoff:{artifacts:[],checks:[
  {id:QUESTION_GOAL_ID,required:true,status:'passed',evidence:'Source and amount agree'},
  {id:'direct-price-field',required:true,status:'not_run',evidence:'Not requested'},
 ],risks:['Intermediate field not located'],returnTo:'none'},environmentQuery:{environmentId:'uat',queryId:'extra',parameters:[]}};
 const checked=assessInvestigation(job,r);
 assert.equal(checked.outcome,'ready');assert.equal(checked.investigation.status,'complete');
 assert.equal(checked.investigation.goals[1].required,false);
 assert.equal(checked.handoff.checks[1].required,false);
 assert.equal(checked.environmentQuery,null);
 assert.equal(investigationComplete(job,checked),true);
 assert.equal(preserveAnalysisGaps(job,checked).outcome,'ready');
 assert.doesNotMatch(preserveAnalysisGaps(job,checked).finalMessage,/仍未核实（沿用本轮调查）/);
});
test('a multi-part original question stays open until every requested answer has evidence',()=>{
 const job={taskIntent:'analysis',stage:'developer',context:[]};
 const r=result();r.outcome='ready';r.investigation={status:'complete',blocker:null,goals:[
  {id:QUESTION_GOAL_ID,required:true,status:'open',evidence:'First requested answer confirmed; second remains unknown'},
  {id:'supporting-detail',required:true,status:'verified',evidence:'Related field found'},
 ],attempts:[],nextStep:'Check second requested answer'};
 const checked=assessInvestigation(job,r);
 assert.equal(checked.outcome,'partial');assert.equal(checked.investigation.status,'continue');
 assert.equal(checked.investigation.goals[1].required,false);
 assert.equal(investigationComplete(job,checked),false);
});
test('new analysis jobs cannot pass the gate by omitting the original-question target',()=>{
 const job={taskIntent:'analysis',stage:'owner_report',questionScopePolicy:'original-question-v1',context:[]};
 const r=result();r.outcome='ready';r.investigation={status:'complete',blocker:null,goals:[
  {id:'supporting-field',required:true,status:'verified',evidence:'The supporting field exists'},
 ],attempts:[],nextStep:''};
 assert.equal(investigationComplete(job,r),false);
 assert.equal(assessInvestigation(job,r).outcome,'partial');
});
test('an already answered question does not become red because an ancillary login is unavailable',()=>{
 const job={taskIntent:'analysis',stage:'owner_report',context:[]};
 const r=result();r.outcome='blocked';r.investigation={status:'wait',goals:[
  {id:QUESTION_GOAL_ID,required:true,status:'verified',evidence:'Actual records and source agree on the cause'},
  {id:'optional-page-log',required:true,status:'open',evidence:'Page login unavailable'},
 ],attempts:['Checked records'],nextStep:'Wait for page login',blocker:{kind:'login',needed:'Page login',evidence:'Login form'}};
 r.handoff.checks=[{id:QUESTION_GOAL_ID,required:true,status:'passed',evidence:'Source and records agree'}];
 r.handoff.returnTo='developer';
 const checked=assessInvestigation(job,r);
 assert.equal(checked.outcome,'ready');assert.equal(checked.investigation.blocker,null);
 assert.equal(checked.handoff.returnTo,'none');assert.match(checked.handoff.risks.join(' '),/Page login/);
 assert.match(checked.summary,/原问题已核实/);assert.match(checked.finalMessage,/补充调查说明/);
});
test('a gateway symptom cannot complete a causal question without root-cause evidence',()=>{
 const job={taskIntent:'analysis',stage:'developer',originalQuestion:'为什么提交时报红 X 和 504？',context:[]};
 const r=result();r.outcome='ready';r.investigation={status:'complete',blocker:null,causalAssessment:{status:'confirmed',link:'direct',mechanism:'confirm 请求收到 504 Gateway Timeout',evidence:[
  {kind:'gateway_response',reference:'network confirm',finding:'HTTP 504'},
  {kind:'screenshot',reference:'user screenshot',finding:'red X'},
 ],alternatives:''},goals:[{id:QUESTION_GOAL_ID,required:true,status:'verified',evidence:'红 X 对应 504；具体超时环节仍未确认'}],attempts:[],nextStep:'查应用日志'};
 assert.equal(requiresCausalEvidence(job),true);
 assert.equal(causalEvidenceComplete(job,r),false);
 const checked=assessInvestigation(job,r);
 assert.equal(checked.outcome,'partial');assert.equal(checked.investigation.status,'continue');
 assert.equal(checked.investigation.goals[0].status,'open');assert.match(checked.summary,/因果证据尚未闭环/);
});
test('a business error plus correlated records can complete a causal question',()=>{
 const job={taskIntent:'analysis',stage:'developer',originalQuestion:'分析提交失败的原因',context:[]};
 const r=result();r.outcome='ready';r.investigation={status:'complete',blocker:null,causalAssessment:{status:'confirmed',link:'direct',mechanism:'重复的第二批252条明细参与校验，触发活动规则日期重叠',evidence:[
  {kind:'business_error',reference:'application log request-1',finding:'活动规则中起止时间有重叠'},
  {kind:'database',reference:'activity_item group count',finding:'252组业务字段各重复2次，共504条'},
 ],alternatives:'附件上传接口已返回成功'},goals:[{id:QUESTION_GOAL_ID,required:true,status:'verified',evidence:'业务错误、重复明细和源码校验路径一致'}],attempts:[],nextStep:''};
 assert.equal(causalEvidenceComplete(job,r),true);assert.equal(assessInvestigation(job,r).outcome,'ready');
});
test('useful findings waiting on unavailable request logs stay partial instead of becoming a generic blocked card',()=>{
 const job={taskIntent:'analysis',stage:'developer',originalQuestion:'提交为什么返回504',questionScopePolicy:'original-question-v1'};
 const actual=assessInvestigation(job,{outcome:'blocked',summary:'已确认新版本和审批状态',finalMessage:'V3已创建并进入审批；具体超时环节仍需请求日志。',
  investigation:{status:'wait',goals:[
   {id:QUESTION_GOAL_ID,required:true,status:'open',evidence:'已确认504后V3创建和审批启动，具体耗时环节未定位。'},
   {id:'post-timeout-state',required:false,status:'verified',evidence:'数据库确认V3和审批实例。'},
  ],attempts:['查询源码和数据库'],nextStep:'取得请求日志',causalAssessment:{status:'unknown',link:'unproven',mechanism:'响应未及时返回',evidence:[
   {kind:'database',reference:'conclusion_info V3',finding:'新版本已创建'},
   {kind:'source',reference:'confirm调用链',finding:'请求同步启动审批'},
  ],alternatives:'具体慢点未排除'},blocker:{kind:'unavailable',needed:'只读请求日志',evidence:'当前没有日志入口'}},
  handoff:{artifacts:[{kind:'code',path:'code.js'}],checks:[
   {id:QUESTION_GOAL_ID,required:true,status:'failed',evidence:'具体超时环节未定位'},
   {id:'post-timeout-state',required:false,status:'passed',evidence:'V3和审批状态已核实'},
  ],risks:['不要重复提交'],returnTo:'none'}});
 assert.equal(actual.outcome,'partial');
 assert.equal(actual.handoff.checks[0].status,'not_run');
 assert.match(actual.finalMessage,/V3已创建/);
});
test('self-review continues with new evidence but stops repeated evidence or explicit external blocker',()=>{
 const r=result(),job={context:[{stage:'owner_report',result:r},{stage:'owner_report',result:r}]};
 assert.equal(reviewDecision(job,r).continue,false);
 const fresh=result();fresh.investigation.goals[0].evidence='Found correct UAT config; database still pending';assert.equal(reviewDecision(job,fresh).continue,true);
 fresh.investigation.status='wait';fresh.investigation.blocker={kind:'login',needed:'Maintainer signs in on the Mac',evidence:'Visible login form'};
 assert.equal(reviewDecision({context:[]},fresh).continue,false);
 fresh.investigation.blocker.evidence='';assert.equal(reviewDecision({context:[]},fresh).continue,true);
});
test('partial owner result atomically resumes same question without grants; duplicate completion rejected',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new JsonStore(path.join(dir,'state.json'));
 await store.createJob({projectId:'p',questionId:'QST-one',senderId:'ou_member',originProfile:'owner',taskIntent:'analysis',workflow:'analysis_review',stage:'owner_report',instruction:'Verify original question'});
 const j=await store.leaseNext('r');const e={type:'completed',runnerId:'r',leaseId:j.lease.id,result:result()};
 const routing={reviewInvestigation:true,agentRole:'developer',agentProfile:'dev'};
 const out=await store.appendEvent(j.id,e,routing);
 assert.equal(out.nextJob.stage,'developer');assert.equal(out.nextJob.status,'queued');
 assert.equal(out.nextJob.questionId,j.questionId);assert.equal(out.nextJob.senderId,j.senderId);assert.equal(out.nextJob.instruction,j.instruction);
 assert.equal(out.nextJob.environmentAccess,undefined);assert.equal(out.nextJob.context.at(-1).result.investigation.goals[0].status,'open');
 await assert.rejects(store.appendEvent(j.id,e,routing));assert.equal((await store.read()).jobs.length,2);
});
test('HTTP completion routes unresolved owner findings to developer and pauses explicit login need',async t=>{
 const {createControlPlane}=await import('../src/control-plane/server.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-review-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'store.json'),conversationFile:path.join(dir,'conversation.json'),memoryFile:path.join(dir,'memory.json'),runnerToken:'test',projects:{projects:{p:{repoPath:dir,analysisRepositories:[{path:'.'}]}}},agents:{agents:{developer:{profile:'dev'},owner_report:{profile:'owner'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 await app.store.createJob({projectId:'p',questionId:'q',taskIntent:'analysis',workflow:'analysis_review',stage:'owner_report',instruction:'Inspect'});
 const j=await app.store.leaseNext('r');
 const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${j.id}/events`;
 const body={type:'completed',runnerId:'r',leaseId:j.lease.id,result:result()};
 const send=()=>fetch(endpoint,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send()).status,200);assert.equal((await send()).status,409);
 const s=await app.store.read();assert.equal(s.jobs.length,2);assert.equal(s.jobs[1].agentProfile,'dev');
 // A separate question that actually needs login stays incomplete, without spinning.
 const {job}=await app.store.createJob({projectId:'p',questionId:'q2',taskIntent:'analysis',workflow:'analysis_review',stage:'owner_report',instruction:'Inspect other page'});
 const rr=result();rr.investigation.status='wait';rr.investigation.blocker={kind:'login',needed:'Maintainer login',evidence:'Password form visible'};
 const out=await app.store.appendEvent(job.id,{type:'completed',result:rr},{reviewInvestigation:true,agentRole:'developer',agentProfile:'dev'});
 assert.equal(out.nextJob,null);assert.match(out.job.result.investigationPause,/Maintainer login/);
});
