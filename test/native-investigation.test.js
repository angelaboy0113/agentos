import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink,realpath,link} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {InvestigationCallJournal,runNativeInvestigation,useNativeInvestigation,nativeInvestigationEngine} from '../src/runner/native-investigation.js';
import {InvestigationToolChannel} from '../src/runner/investigation-tool-channel.js';
import {InvestigationDirectTools} from '../src/runner/investigation-direct-tools.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
import {planQuery} from '../src/shared/environment-access.js';

async function temp(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'agentos-native-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const job={id:'JOB-synthetic',questionId:'QST-synthetic',taskIntent:'analysis',stage:'developer',continuousInvestigation:true,projectId:'a',senderId:'owner',originProfile:'a',lease:{runnerId:'runner',id:'lease'}};
test('engine opt-in preserves old threads and non-analysis workflows',()=>{
  assert.equal(useNativeInvestigation(job,{analysisEngine:nativeInvestigationEngine},null),true);
  assert.equal(useNativeInvestigation(job,{analysisEngine:'legacy'},null),false);
  assert.equal(useNativeInvestigation(job,{analysisEngine:nativeInvestigationEngine},'old-thread'),false);
  assert.equal(useNativeInvestigation({...job,taskIntent:'implementation'},{analysisEngine:nativeInvestigationEngine},null),false);
  assert.equal(useNativeInvestigation({...job,analysisContinuation:{executionEngine:nativeInvestigationEngine}},{analysisEngine:'legacy'},'native-thread'),true);
});
test('call journal deduplicates concurrent and restored calls; changed arguments are rejected',async t=>{
  const directory=await temp(t);let count=0;const j=new InvestigationCallJournal({directory,binding:'owner-env'});
  const run=async()=>{count++;return {contentItems:[{type:'inputText',text:'ok'}],success:true};};
  const [a,b]=await Promise.all([j.call('call',{n:1},run),j.call('call',{n:1},run)]);assert.deepEqual(a,b);assert.equal(count,1);
  assert.deepEqual(await new InvestigationCallJournal({directory,binding:'owner-env'}).call('call',{n:1},run),a);assert.equal(count,1);
  await assert.rejects(()=>j.call('call',{n:2},run),/CONFLICT/);
  await new InvestigationCallJournal({directory,binding:'other-env'}).call('call',{n:1},run);assert.equal(count,2);
});
test('uncertain interrupted call is preserved and never automatically re-executed',async t=>{
  const directory=await temp(t),j=new InvestigationCallJournal({directory,binding:'scope'});let count=0;
  await assert.rejects(()=>j.call('x',{},async()=>{count++;throw new Error('disconnect');}),/disconnect/);
  await assert.rejects(()=>new InvestigationCallJournal({directory,binding:'scope'}).call('x',{},async()=>count++),/UNCERTAIN/);assert.equal(count,1);
});
test('linked call receipts are rejected without touching the linked target',async t=>{
  const directory=await temp(t),target=path.join(directory,'outside.json');await writeFile(target,'unchanged');
  for(const mode of ['symlink','hardlink']){
    const key=createHash('sha256').update(JSON.stringify(['scope',mode])).digest('hex'),file=path.join(directory,`.native-call-${key}.json`);
    if(mode==='symlink')await symlink(target,file);else await link(target,file);
    await assert.rejects(()=>new InvestigationCallJournal({directory,binding:'scope'}).call(mode,{},async()=>{throw Error('Must not execute');}),/BOUNDARY/);
  }
});
test('coroutine executes many tools with one planner adapter; error correction and completion stay in the same channel',async()=>{
  const c=new InvestigationToolChannel(),p=c.planner();
  const run=(async()=>{const first=await p.next({tools:[{tool:'schema'}],results:[]});assert.equal(first.tool,'schema');const second=await p.next({tools:[{tool:'select'}],results:[{tool:'schema',error:{code:'TOOL_ARGUMENTS'}}]});assert.equal(second.tool,'select');const final=await p.next({tools:[],results:[{tool:'select',result:{rows:[{n:2}]}}]});assert.equal(final.tool,'finish');c.settle({outcome:'ready'});})();
  assert.equal((await c.observe()).state,'tools');assert.equal((await c.choose({tool:'schema'})).state,'tools');assert.equal((await c.choose({tool:'select'})).state,'tools');assert.equal((await c.choose({tool:'finish'})).result.outcome,'ready');await run;
});
test('two environments use existing grant and persistence endpoints, no environment model or hidden cross-scope call',async()=>{
  const routes=[],seen=[];let current={...job};
  const direct=new InvestigationDirectTools({job:current,config:{},emit:async()=>{},workspace:'/fixed',sourceSync:{}},{
    post:async(route,body)=>{routes.push(route);assert.equal(body.leaseId,'lease');if(route.endsWith('continuous-environment')){current={...current,environmentAccess:{environmentId:body.result.environmentQuery.environmentId}};return {planned:true,job:current};}current={...current};delete current.environmentAccess;return {job:current};},
    execute:async(j,_config,_emit,{planner})=>{seen.push(j.environmentAccess.environmentId);const p=await planner();let choice=await p.next({tools:[{tool:'schema'}],results:[]});assert.equal(choice.tool,'schema');choice=await p.next({tools:[{tool:'select'}],results:[{tool:'schema',result:{columns:['n']}}]});assert.equal(choice.tool,'finish');await p.close();return {outcome:'ready',environmentEvidence:{environmentId:j.environmentAccess.environmentId},finalMessage:'saved'};},
  });
  for(const id of ['a-prd','b-prd']){
    assert.equal((await direct.call('agentos_environment_open',{request:JSON.stringify({environmentId:id}),website:false})).state,'tools');
    await assert.rejects(()=>direct.call('agentos_environment_open',{request:'{}',website:false}),/Close/);
    await assert.rejects(()=>direct.call('agentos_environment_tool',{tool:'continue_environment',arguments:'{}'}),/explicitly/);
    await direct.call('agentos_environment_tool',{tool:'schema',arguments:'{}',summary:'read'});
    assert.equal((await direct.call('agentos_environment_close',{summary:'saved',complete:true})).state,'saved');
  }
  assert.deepEqual(seen,['a-prd','b-prd']);assert.equal(routes.length,4);await direct.close();
});
test('login and failed reads preserve formal waiting instead of publishing successful environment evidence',async()=>{
  const calls=[];const direct=new InvestigationDirectTools({job,config:{},emit:async()=>{}},{post:async route=>{calls.push(route);return {planned:true,job};},execute:async()=>({outcome:'needs_clarification',browserLoginRequired:true,browserCheckpoint:{saved:true},finalMessage:'login'})});
  const result=await direct.call('agentos_environment_open',{request:'{}',website:false});assert.equal(result.state,'waiting');assert.equal(direct.waiting.browserLoginRequired,true);assert.equal(calls.length,1);await direct.close();
});
test('rejected scope never creates an environment executor',async()=>{
  let executions=0;const direct=new InvestigationDirectTools({job},{post:async()=>({planned:false,job,diagnostic:{code:'APPROVAL_REQUIRED'}}),execute:async()=>executions++});
  const result=await direct.call('agentos_environment_open',{request:'{}',website:false});assert.equal(result.state,'not_opened');assert.equal(executions,0);
});
test('native model runs a tool chain in one thread and rejects foreign identity and builtin tools',async t=>{
  const directory=await temp(t),events=[],requests=[];let handler;const app=new EventEmitter();
  app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};
  app.request=async(method,params)=>{requests.push({method,params});return {thread:{id:'thread'}};};
  app.turn=async()=>{
    app.emit('notification',{method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
    await assert.rejects(()=>handler({threadId:'foreign',turnId:'turn',namespace:null,callId:'1',tool:'agentos_source_history',arguments:{query:'{}'}}),/SCOPE/);
    await assert.rejects(()=>handler({threadId:'thread',turnId:'turn',namespace:null,callId:'2',tool:'exec',arguments:{}}),/SCOPE/);
    for(const id of ['3','4'])assert.equal((await handler({threadId:'thread',turnId:'turn',namespace:null,callId:id,tool:'agentos_source_history',arguments:{query:'{}'}})).success,true);
    return {text:JSON.stringify({outcome:'ready',finalMessage:'verified',summary:'done'})};
  };
  let tools=0;const direct={job,sourceReceipts:[],call:async()=>({rows:[{n:++tools}]}),close:async()=>{}};
  const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'synthetic only',emit:async e=>events.push(e)},{app,direct,runtime:async()=>({model:'local-test'}),bindToolCall:h=>handler=h});
  assert.equal(requests.filter(x=>x.method==='thread/start').length,1);assert.equal(result.nativeTiming.modelSessions,1);assert.equal(result.nativeTiming.environmentModelSessions,0);assert.equal(result.nativeTiming.toolCalls,2);assert.equal(events[0].sourceContinuation.executionEngine,nativeInvestigationEngine);
});

test('real investigator coroutine still revalidates revoked permission before a tool executes',async t=>{
  const directory=await temp(t),environment={kind:'nacos',projectId:'demo',tier:'uat',credentialRef:'fake',baseUrl:'http://localhost:8848/nacos',ownerOpenIdsByProfile:{owner:['admin']},membersRead:true,queries:{investigate:{mode:'investigate',reviewed:true,description:'fixture',namespaces:['uat'],maxRows:5,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]}}};
  const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['fixture']},'demo',{profile:'owner',senderId:'member'}),c=new InvestigationToolChannel();
  let reads=0;
  const running=investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({username:'fixture',password:'fixture-secret'}),exportDirectory:directory,tools:async()=>({spec:[{tool:'connection'},{tool:'read_config'}],run:async tool=>{if(tool==='read_config')reads++;return {rows:[]};},close:async()=>{}}),planner:async()=>c.planner()}).then(result=>c.settle(result),error=>c.fail(error));
  assert.equal((await c.observe()).state,'tools');cfg.environments.env.membersRead=false;
  const paused=await c.choose({tool:'read_config',arguments:'{}',summary:'read'});assert.equal(paused.state,'tools');
  const result=await c.choose({tool:'finish',arguments:'{}',summary:'Permission revoked; preserve existing evidence',complete:false});
  await running;assert.equal(reads,0);assert.equal(result.state,'finished');assert.equal(result.result.partial,true);
});

test('explicit second environment requests a verified source transition without changing active state',async()=>{
  let posts=0;
  const project={analysisSourceMode:'isolated',analysisEnvironments:{sit:{runtimeTier:'uat'},prd:{runtimeTier:'prd'}}};
  const direct=new InvestigationDirectTools({job:{...job,sourceEnvironment:'prd',originalQuestion:'Compare SIT and PRD'},project},{loadEnvironments:async()=>({environments:{sit:{tier:'uat'}}}),post:async()=>{posts++;throw Error('Should not change state');}});
  const response=await direct.call('agentos_environment_open',{request:JSON.stringify({environmentId:'sit'}),website:false});
  assert.equal(response.state,'source_transition_required');assert.equal(posts,0);
});

for(const mode of ['continue','waiting','source-transition'])test(`legacy-shaped continuation stays in native thread: ${mode}`,async t=>{
 const directory=await temp(t),app=new EventEmitter(),calls=[],requests=[];let turns=0,handler;
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async(method,params)=>{requests.push({method,params});return{thread:{id:'one-thread'}};};
 const direct={job,sourceReceipts:[],channel:null,call:async(name,args)=>{calls.push(name);if(name==='agentos_environment_close'){direct.channel=null;return{state:'saved',result:{outcome:'partial'}};}if(mode==='waiting'){direct.waiting={outcome:'needs_clarification',browserLoginRequired:true,finalMessage:'Login required'};return{state:'waiting'};}if(mode==='source-transition')return{state:'source_transition_required',sourceEnvironmentQuery:{environmentId:'sit'}};direct.channel={};return{state:'tools',input:{tools:[{tool:'select'}],results:[]}};},close:async()=>{}};
 app.turn=async params=>{turns++;app.emit('notification',{method:'turn/started',params:{threadId:'one-thread',turn:{id:'turn-'+turns}}});if(turns===1)return{text:JSON.stringify({outcome:'needs_clarification',summary:'read',finalMessage:'Need database',environmentQuery:{environmentId:'approved-db',queryId:'investigate',parameters:['read']}})};
 assert.equal(params.threadId,'one-thread');assert.match(params.input[0].text,/host_continuation|tools/);await handler({threadId:'one-thread',turnId:'turn-2',namespace:null,callId:'close',tool:'agentos_environment_close',arguments:{summary:'verified',complete:true}});return{text:JSON.stringify({outcome:'ready',summary:'verified',finalMessage:'Actual answer',environmentQuery:null})};};
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({model:'fixture'}),bindToolCall:h=>handler=h});
 assert.equal(requests.length,1);assert.equal(result.nativeTiming.modelSessions,1);assert.equal(result.nativeTiming.environmentModelSessions,0);assert.equal(calls[0],'agentos_environment_open');if(mode==='continue'){assert.equal(turns,2);assert.equal(result.outcome,'ready');assert.equal(result.nativeTiming.hostContinuations,1);}else{assert.equal(turns,1);if(mode==='waiting')assert.equal(result.browserLoginRequired,true);else assert.equal(result.sourceEnvironmentQuery.environmentId,'sit');}
});
