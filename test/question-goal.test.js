import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {assessInvestigation,investigationComplete} from '../src/shared/investigation-review.js';
import {jobCard} from '../src/control-plane/message-cards.js';
const original='Assess budget history, occupancy and incremental changes';
const initial={outcome:'partial',investigation:{status:'continue',goals:[{id:'original-question',required:true,status:'open',evidence:'History and occupancy still need live records'},{id:'history',required:false,status:'open',evidence:'Needs live records'},{id:'occupancy',required:false,status:'open',evidence:'Needs occupied amounts'}]}};
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'question-goal-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new JsonStore(path.join(dir,'state.json'));await store.transact(s=>{s.questions={q:{id:'q',rootTurnId:'root',projectId:'p',chatId:'g'}};s.conversations=[{id:'root',content:original}];});return store;}
const input={questionId:'q',projectId:'p',chatId:'g',taskIntent:'analysis',stage:'developer',workflow:'analysis_review',senderId:'member',originProfile:'owner',instruction:original};
test('URL supplement preserves root goals through environment evidence and rejects false green',async t=>{
 const store=await fixture(t);const first=(await store.createJob({...input,attachments:[{id:'screenshot'}]})).job;
 assert.equal(first.questionScopePolicy,'original-question-v1');
 await store.transact(s=>{Object.assign(s.jobs[0],{status:'completed',result:initial});});
 const step=(await store.createJob({...input,originalQuestion:'Here is the Nacos URL',instruction:'Read endpoint',workflow:'single_developer',environmentAccess:{tier:'uat'},sourceMessageId:'supplement'})).job;
 assert.equal(step.originalQuestion,original);assert.equal(step.missionId,first.missionId);assert.equal(step.context.length,1);assert.equal(step.attachments[0].id,'screenshot');
 await store.leaseNext('runner');
 const next=(await store.appendEvent(step.id,{type:'completed',result:{outcome:'ready',finalMessage:'Database endpoint found'}},{resumeInvestigation:true,agentRole:'developer',agentProfile:'dev'})).nextJob;
 assert.equal(next.originalQuestion,original);assert.equal(next.instruction,original);assert.equal(next.environmentAccess,undefined);
 assert.equal(next.questionScopePolicy,'original-question-v1');
 const falseComplete={outcome:'ready',summary:'Endpoint found',investigation:{status:'complete',goals:[{id:'endpoint',status:'verified',evidence:'Address found'}]}};
 assert.equal(investigationComplete(next,falseComplete),false);
 const reviewed=assessInvestigation(next,falseComplete);assert.equal(reviewed.outcome,'partial');
 assert.notEqual(jobCard({...next,status:'completed',result:reviewed}).header.template,'green');
 const resolved={outcome:'ready',investigation:{status:'complete',goals:[{id:'original-question',required:true,status:'verified',evidence:'Actual history and occupied amounts verified'},{id:'history',required:false,status:'verified',evidence:'Actual historical records verified'},{id:'occupancy',required:false,status:'verified',evidence:'Actual occupied amounts verified'}]}};
 assert.equal(investigationComplete(next,resolved),true);
 const again=(await store.createJob({...input,instruction:'Additional information',sourceMessageId:'next'})).job;
 assert.equal(again.context.filter(x=>x.result?.investigation?.goals?.[0]?.id==='original-question').length,1);
});
test('evidence never crosses question, project or chat and direct address questions still complete',async t=>{
 const store=await fixture(t);await store.createJob(input);await store.transact(s=>{Object.assign(s.jobs[0],{status:'completed',result:initial});});
 for(const changes of [{questionId:'other'},{projectId:'other'},{chatId:'other'}]){
  const j=(await store.createJob({...input,...changes,instruction:'Which database address?',originalQuestion:'Which database address?'})).job;
  assert.equal(j.originalQuestion,'Which database address?');assert.equal(j.context.length,0);
  assert.equal(investigationComplete(j,{investigation:{status:'complete',goals:[{id:'original-question',required:true,status:'verified',evidence:'Configured address verified'}]}}),true);
 }
});
