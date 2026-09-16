import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionEndpoints,connectionCandidates} from '../src/shared/connection-endpoints.js';
import {ConversationService} from '../src/control-plane/conversations.js';
import {jobTerminalMention} from '../src/control-plane/requester-mention.js';
const now=()=>new Date().toISOString();
const job=()=>({id:'j',questionId:'parent',chatId:'c',projectId:'p',originProfile:'o',status:'completed',updatedAt:now(),environmentAccess:{tier:'prd',startedAt:now(),scopeHash:'h'},result:{outcome:'ready',environmentEvidence:{scopeHash:'h',readAt:now()},connectionEndpoints:[{host:'db.test',port:3306,database:'demo',password:'do-not-copy'}]}});
test('connection metadata is bounded and isolated to related questions and matching evidence',()=>{
 const turn={questionId:'q',chatId:'c',profile:'o'},state={questions:{q:{id:'q',parentQuestionId:'parent'},parent:{id:'parent'}},jobs:[job()]};
 assert.equal(connectionCandidates(state,turn,'p').length,1);
 assert.doesNotMatch(JSON.stringify(connectionCandidates(state,turn,'p')),/password|do-not-copy/);
 for(const mutate of [j=>j.chatId='else',j=>j.projectId='else',j=>j.questionId='else',j=>j.originProfile='else',j=>j.updatedAt='2020-01-01',j=>j.result.environmentEvidence.scopeHash='else',j=>j.status='failed']) {const copy=structuredClone(state);mutate(copy.jobs[0]);assert.equal(connectionCandidates(copy,turn,'p').length,0);}
 assert.deepEqual(connectionEndpoints([{host:'user@host',port:3306,database:'x'},{host:'db',port:0,database:'x'}]),[]);
});
test('connect followup fills a unique discovered address and multiple databases require selection',async()=>{
 const state={questions:{q:{id:'q',parentQuestionId:'parent'},parent:{id:'parent'}},jobs:[job()],conversations:[]};
 const context={projects:{chatProjectMap:{c:'p'},projects:{p:{}}},store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)}};
 const make=()=>({id:'turn',questionId:'q',chatId:'c',profile:'o',senderId:'member',decision:{action:'request_environment_setup',intent:'analysis',attachmentIds:[],environmentSetup:{kind:'mysql',tier:'prd',url:''}}});
 const out=await ConversationService.prototype.apply.call({context},make());assert.ok(out.enrollmentId);assert.equal(Object.values(state.environmentEnrollments)[0].url,'mysql://db.test:3306/demo');
 state.jobs[0].result.connectionEndpoints.push({host:'db.test',port:3306,database:'second'});
 assert.match((await ConversationService.prototype.apply.call({context},make())).notice,/多个数据库/);assert.equal(Object.keys(state.environmentEnrollments).length,1);
 assert.equal(jobTerminalMention({status:'completed',connectionEnrollmentPending:true}),null);
});

test('missing metadata schedules approved-scope Nacos discovery under original member identity',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {JsonStore}=await import('../src/shared/store.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'connection-discovery-'));const prev=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(prev===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=prev;await rm(dir,{recursive:true,force:true});});
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{source:{kind:'nacos',projectId:'p',tier:'prd',credentialRef:'fake',baseUrl:'http://example.test:8848/nacos',ownerOpenIdsByProfile:{o:['ou_admin']},membersRead:false,queries:{investigate:{mode:'investigate',reviewed:true,description:'read config',namespaces:['prd'],maxCalls:6,maxRows:5,timeoutMs:1000,parameters:[{name:'purpose',type:'string',maxLength:200}]}}}}}));
 const store=new JsonStore(path.join(dir,'state.json'));const turn={id:'turn',questionId:'q',chatId:'c',chatType:'group',profile:'o',role:'owner_intake',senderId:'ou_member',messageId:'m',decision:{action:'request_environment_setup',intent:'analysis',instruction:'connect PRD',attachmentIds:[],environmentSetup:{kind:'mysql',tier:'prd',url:''}}};
 await store.transact(s=>{s.conversations=[turn];s.questions={q:{id:'q'}};});
 const context={store,projects:{chatProjectMap:{c:'p'},projects:{p:{}},ownerOpenIdsByProfile:{o:['ou_admin']}},agents:{agents:{developer:{profile:'dev'}}}};
 await ConversationService.prototype.apply.call({context},turn);
 const state=await store.read(), j=state.jobs[0];assert.equal(j.status,'awaiting_environment_approval');assert.equal(j.senderId,'ou_member');assert.equal(j.connectionEnrollmentPending,true);assert.equal(state.conversations[0].decision.environmentSetup.url,'');assert.equal(j.environmentAccess.environmentId,'source');assert.equal(await store.leaseNext('r'),null);
 await store.transact(s=>{s.jobs[0].status='completed';});
 turn.environmentResumeKey='ENR-synthetic';turn.decision.environmentSetup=null;
 await ConversationService.prototype.apply.call({context},turn);
 const resumed=await store.read();assert.equal(resumed.jobs.length,2);assert.notEqual(resumed.jobs[0].sourceMessageId,resumed.jobs[1].sourceMessageId);assert.equal(resumed.jobs[1].status,'awaiting_environment_approval');

});
