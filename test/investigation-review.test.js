import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {assessInvestigation,investigationComplete,reviewDecision} from '../src/shared/investigation-review.js';
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
