import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/shared/store.js';
import { environmentContinuation } from '../src/shared/investigation-review.js';

const request={environmentId:'prd-db',queryId:'investigate',parameters:['check budget']};
const result=(verified=[])=>({investigation:{status:'continue',goals:[
  {id:'source',status:verified.includes('source')?'verified':'open',evidence:verified.includes('source')?'source checked':'pending'},
  {id:'runtime',status:verified.includes('runtime')?'verified':'open',evidence:verified.includes('runtime')?'rows checked':'pending'},
]}});

test('same environment target converges after two restarts without new verified goals',()=>{
 const job={questionId:'q',taskIntent:'analysis'};
 const state={jobs:[0,1].map(i=>({id:`env-${i}`,questionId:'q',taskIntent:'analysis',environmentAccess:request,result:{...result(['source']),finalMessage:`evidence-${i}`}}))};
 assert.equal(environmentContinuation(state,job,request,result()).continue,false);
 assert.equal(environmentContinuation({jobs:[]},job,{...request,goalIds:null},result()).continue,true);
 assert.equal(environmentContinuation(state,job,request,result(['runtime'])).continue,true);
 assert.equal(environmentContinuation(state,job,{...request,queryId:'browser'},result()).continue,true);
});

test('a new evidence-backed point query may target one remaining required goal exactly once',()=>{
 const job={questionId:'q',taskIntent:'analysis'};
 const state={jobs:[0,1].map(i=>({id:`env-${i}`,questionId:'q',taskIntent:'analysis',environmentAccess:request,result:{...result(['source']),finalMessage:`evidence-${i}`}}))};
 const targeted={...request,parameters:['check exact fee record'],goalIds:['runtime']};
 const first=environmentContinuation(state,job,targeted,result(['source']));
 assert.equal(first.continue,true);assert.deepEqual(first.metadata.continuationGoalIds,['runtime']);
 const repeated={jobs:[...state.jobs,{id:'active',questionId:'q',taskIntent:'analysis',continuousContinuationKeys:[first.metadata.continuationKey]}]};
 const again=environmentContinuation(repeated,job,{...targeted,parameters:['reword exact fee query']},result(['source']));
 assert.equal(again.continue,false);assert.match(again.reason,/证据没有变化/);
 const changed=result(['source']);changed.investigation.goals[1].evidence='发现费用记录主键 fee-130，待定向读取';
 assert.equal(environmentContinuation(repeated,job,targeted,changed).continue,true);
});

test('targeted continuation rejects verified, optional and unknown goals',()=>{
 const job={questionId:'q',taskIntent:'analysis'};
 const state={jobs:[0,1].map(i=>({id:`env-${i}`,questionId:'q',taskIntent:'analysis',environmentAccess:request}))};
 const current=result(['source']);current.investigation.goals.push({id:'optional',required:false,status:'open',evidence:'nice to have'});
 for(const goalIds of [['source'],['optional'],['missing'],[]]){
  const decision=environmentContinuation(state,job,{...request,goalIds},current);
  assert.equal(decision.continue,false);
 }
});

test('continuous job changes evidence path after one empty partial website round',()=>{
 const request={environmentId:'prd-site',queryId:'investigate',kind:'website',parameters:['check record']};
 const evidence={...request,rowCount:0};
 const job={questionId:'q',taskIntent:'analysis',context:[{kind:'environment_result',result:{outcome:'partial',environmentEvidence:evidence}}]};
 const state={jobs:[job]};
 const decision=environmentContinuation(state,job,request,result());
 assert.equal(decision.continue,false);assert.match(decision.reason,/数据库、源码/);
 assert.equal(environmentContinuation(state,job,{...request,environmentId:'prd-db',queryId:'records',kind:'mysql'},result()).continue,true);
});

test('question context stays bounded instead of copying every prior context',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-context-bound-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),store=new JsonStore(file);
 await store.transact(s=>{s.questions={q:{id:'q',rootTurnId:'root',projectId:'p',chatId:'g'}};s.conversations=[{id:'root',content:'root question'}];});
 for(let i=0;i<30;i++){
  const {job}=await store.createJob({questionId:'q',projectId:'p',chatId:'g',taskIntent:'analysis',stage:'developer',workflow:'analysis_review',instruction:'root question'});
  await store.transact(s=>{const current=s.jobs.find(item=>item.id===job.id);current.status='completed';current.result={...result(i?[]:['source']),finalMessage:`round ${i} ${'x'.repeat(500)}`};});
 }
 const state=await store.read();
 assert.ok(state.jobs.every(job=>job.context.length<=8));
 assert.ok((await readFile(file)).length<300_000);
 assert.equal(state.jobs.at(-1).originalQuestion,'root question');
});

test('startup migration compacts legacy history and turns a runaway chain into one final report',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-convergence-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),jobs=[];
 for(let i=0;i<15;i++){
  const evidence=jobs.filter(job=>job.result).map(job=>({stage:job.stage,result:job.result}));
  jobs.push({id:`job-${i}`,questionId:'q',missionId:'m',projectId:'p',chatId:'g',taskIntent:'analysis',stage:'developer',workflow:'analysis_review',instruction:'why',originalQuestion:'why',context:evidence,attachments:[],events:[],status:i===14?'running':'completed',lease:i===14?{id:'lease',runnerId:'old'}:null,result:i===14?null:{...result(),finalMessage:`round ${i}`},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 }
 await writeFile(file,JSON.stringify({version:1,jobs,runners:{},processedMessages:{}}));
 const store=new JsonStore(file);
 assert.deepEqual(await store.reconcileInvestigationState('owner'),{compacted:14,finalized:1});
 const state=await store.read(),old=state.jobs.at(-2),final=state.jobs.at(-1);
 assert.equal(old.status,'completed');assert.equal(old.context.length,0);assert.equal(old.lease,null);
 assert.equal(final.stage,'owner_report');assert.equal(final.workflow,'owner_report');assert.equal(final.status,'queued');assert.equal(final.convergenceFinal,true);
 assert.ok(final.context.length<=8);assert.ok(state.jobs.slice(0,-1).every(job=>job.context.length===0));
 assert.deepEqual(await store.reconcileInvestigationState('owner'),{compacted:0,finalized:0});
});
