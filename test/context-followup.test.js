import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ConversationService,conversationJobResult} from '../src/control-plane/conversations.js';
import {fitContext,memorySettings,estimateTokens} from '../src/control-plane/memory.js';

test('normal required routing metadata and explicit definitions fit the default budget without deletion',()=>{
 const defs=[{definition:'已确认'.repeat(700)}],input={message:'用文字，不要表格',businessDefinitions:defs,environmentCatalog:'r'.repeat(5200),assistantScope:'s'.repeat(2400),project:'p'.repeat(2600),administrator:false,history:[],jobs:[]};
 assert.ok(estimateTokens(input)>13488);const out=fitContext(input,memorySettings());assert.equal(out.message,'用文字，不要表格');assert.deepEqual(out.businessDefinitions,defs);assert.equal(out.administrator,false);
 assert.throws(()=>fitContext({...input,message:'z'.repeat(80000)},memorySettings()),/budget/);
});
const answer='客户A：已核验余额105.32，取数时间2026-10-01；各源时间不同。';
function job(overrides={}){return {id:'j',questionId:'parent',chatId:'g',projectId:'p',originProfile:'assistant',taskIntent:'analysis',status:'completed',stage:'developer',instruction:'查余额',sourceEnvironment:'prd',updatedAt:'2026-10-01T00:00:00Z',environmentAccess:{environmentId:'db'},result:{workspace:'/snapshot',sourceSync:{policy:'isolated-environment-source-v1',sourceRoot:'/project',environment:'prd'},finalMessage:answer},...overrides};}
test('completed final delivery survives stale environment grant; subtask/current foreign source remains protected',()=>{
 assert.equal(conversationJobResult(job(),'/project'),answer);
 assert.match(conversationJobResult(job({status:'running'}),'/project'),/明细不注入/);
 assert.match(conversationJobResult(job({result:{finalMessage:'raw environment detail'}}),'/project'),/明细不注入/);
 assert.match(conversationJobResult(job(),'/different-project'),/不适用于当前源码/);
 const long=job();long.result.finalMessage='a'.repeat(7000);assert.match(conversationJobResult(long,'/project'),/仅为节选/);
});
test('pinned final answer survives soft history trimming, but other project/profile/private topic cannot enter it',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'agentos-followup-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const turn={id:'c',messageId:'m',questionId:'child',chatId:'g',profile:'assistant',senderId:'b',projectId:'p',role:'developer',chatType:'group',content:'改成文字',attachments:[]};
 const state={questions:{child:{id:'child',chatId:'g',profile:'assistant',projectId:'p',parentQuestionId:'parent'},parent:{id:'parent',chatId:'g',profile:'assistant',projectId:'p'}},conversations:[turn],jobs:[job(),job({id:'foreign-profile',originProfile:'other'}),job({id:'foreign-project',projectId:'other'}),job({id:'private',visibility:'requester',senderId:'other'})]};
 const service=new ConversationService({config:{dataDir},store:{read:async()=>structuredClone(state)},projects:{projects:{p:{repoPath:'/project'}},chatProjectMap:{g:'p'}}},{decide:()=>{},memorySettings:memorySettings({historyBudgetTokens:500})});
 const input=await service.buildInput(turn);assert.deepEqual(input.jobs,[]);assert.equal(input.questionResult.length,1);assert.equal(input.questionResult[0].jobId,'j');assert.equal(input.questionResult[0].finalMessage,answer);assert.match(input.questionResult[0].policy,/不是新查询/);assert.equal(input.administrator,false);
});
