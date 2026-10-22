import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {ConversationService} from '../src/control-plane/conversations.js';
test('missing configuration source schedules scoped source discovery before asking the user; its unchanged handoff does not loop',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'source-discovery-')),prev=process.env.AGENTOS_ENVIRONMENTS_FILE;
 process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(root,'env.json');await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{}}));
 t.after(async()=>{if(prev===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=prev;await rm(root,{recursive:true,force:true});});
 const store=new JsonStore(path.join(root,'state.json'));
 const turn={id:'setup',questionId:'q',chatId:'group',chatType:'group',profile:'owner',role:'owner_intake',senderId:'ou_member',messageId:'message',setupPending:true,decision:{action:'request_environment_setup',intent:'analysis',instruction:'export recent business objects',sourceEnvironment:'prd',environmentSetup:{kind:'mysql',tier:'prd',url:''},attachmentIds:[]}};
 await store.transact(s=>{s.questions={q:{id:'q',projectId:'p',chatId:'group',rootTurnId:'setup'}};s.conversations=[structuredClone(turn)];});
 const context={store,projects:{chatProjectMap:{group:'p'},projects:{p:{analysisSourceMode:'isolated',analysisEnvironments:{prd:{}}}}},agents:{agents:{developer:{profile:'dev'}}}};
 const service={context,update:async(id,patch)=>store.transact(s=>Object.assign(s.conversations.find(t=>t.id===id),patch))};
 const first=await ConversationService.prototype.apply.call(service,structuredClone(turn));assert.ok(first.jobId);
 let s=await store.read(),j=s.jobs[0];assert.equal(j.connectionSourceDiscovery.tier,'prd');assert.equal(j.sourceEnvironment,'prd');assert.equal(j.senderId,'ou_member');assert.equal(j.environmentAccess,undefined);assert.match(j.instruction,/不能默认是Nacos/);assert.match(j.instruction,/注释地址/);assert.equal(s.conversations[0].setupPending,false);
 await store.transact(s=>{s.jobs[0].status='completed';});
 const follow={...structuredClone(turn),id:'follow',setupSourceJobId:j.id};
 await store.transact(s=>s.conversations.push(structuredClone(follow)));
 const repeated=await ConversationService.prototype.apply.call(service,follow);assert.equal(repeated.jobId,undefined);assert.match(repeated.notice,/已自动检查/);assert.equal((await store.read()).jobs.length,1);
 // A different environment is a different scope, not evidence that it was already inspected.
 const other={...structuredClone(turn),id:'other',setupSourceJobId:j.id,decision:{...turn.decision,sourceEnvironment:'sit',environmentSetup:{kind:'mysql',tier:'uat',url:''}}};context.projects.projects.p.analysisEnvironments.sit={};
 await store.transact(s=>{s.conversations.push(structuredClone(other));});assert.ok((await ConversationService.prototype.apply.call(service,other)).jobId);
});
