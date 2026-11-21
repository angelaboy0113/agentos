import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink,realpath,link} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {InvestigationCallJournal,runNativeInvestigation,useNativeInvestigation,nativeInvestigationEngine,presentNativeToolResult} from '../src/runner/native-investigation.js';
import {InvestigationToolChannel} from '../src/runner/investigation-tool-channel.js';
import {InvestigationDirectTools} from '../src/runner/investigation-direct-tools.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
import {planQuery} from '../src/shared/environment-access.js';

async function temp(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'agentos-native-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const job={id:'JOB-synthetic',questionId:'QST-synthetic',taskIntent:'analysis',stage:'developer',continuousInvestigation:true,projectId:'a',senderId:'owner',originProfile:'a',lease:{runnerId:'runner',id:'lease'}};
test('initial grant uses the validated executor coroutine, closes to original state and rejects another tier',async()=>{
 const granted={...job,sourceEnvironment:'prd',environmentAccess:{environmentId:'db-a',tier:'prd',queryId:'investigate',parameters:['original goal'],signature:'host-approved'}};
 const project={analysisEnvironments:{prd:{runtimeTier:'prd'},sit:{runtimeTier:'uat'}}};let executions=0,posts=0;
 const direct=new InvestigationDirectTools({job:granted,project,config:{},emit:async()=>{},workspace:'/fixed'}, {
  execute:async(j,_c,_e,{planner})=>{executions++;assert.deepEqual(j.environmentAccess,granted.environmentAccess);const p=await planner({kind:'mysql'});const choice=await p.next({tools:[{tool:'schema'}],results:[]});assert.equal(choice.tool,'schema');await p.next({tools:[],results:[{tool:'schema',result:{columns:['id']}}]});await p.close();return{outcome:'ready',finalMessage:'verified original data'};},
  post:async(route,body)=>{posts++;assert.ok(route.endsWith('continuous-environment-result'));assert.equal(body.leaseId,'lease');return{job:{...granted,environmentAccess:null}};}
 });
 assert.equal((await direct.openInitial()).state,'tools');assert.equal(await direct.openInitial(),null);
 await direct.call('agentos_environment_tool',{tool:'schema',arguments:'{}',summary:'inspect'});
 assert.equal((await direct.call('agentos_environment_close',{summary:'saved',complete:true})).state,'saved');
 assert.equal(executions,1);assert.equal(posts,1);await direct.close();
 const wrong=new InvestigationDirectTools({job:{...granted,sourceEnvironment:'sit'},project},{execute:async()=>{throw Error('Must not execute');}});
 await assert.rejects(()=>wrong.openInitial(),e=>e.queryDiagnostic?.code==='ENVIRONMENT_MISMATCH');
});
test('main native model receives an already approved initial catalog and keeps one thread',async t=>{
 const directory=await temp(t),app=new EventEmitter();let handler,opened=0,turns=0;
 const direct={job,sourceReceipts:[],openInitial:async()=>{opened++;direct.channel={};return{state:'tools',input:{tools:[{tool:'schema'}],results:[]}};},call:async()=>{direct.channel=null;return{state:'saved'};},close:async()=>{}};
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.request=async()=>({thread:{id:'initial-thread'}});app.close=async()=>{};
 app.turn=async p=>{turns++;assert.match(p.input[0].text,/initial_environment|首个只读来源/);assert.match(p.input[0].text,/schema/);app.emit('notification',{method:'turn/started',params:{threadId:'initial-thread',turn:{id:'one'}}});await handler({threadId:'initial-thread',turnId:'one',namespace:null,callId:'close-initial',tool:'agentos_environment_close',arguments:{summary:'saved',complete:true}});return{text:JSON.stringify({outcome:'ready',summary:'verified',finalMessage:'complete original answer'})};};
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({}),bindToolCall:h=>handler=h});
 assert.equal(opened,1);assert.equal(turns,1);assert.equal(result.nativeTiming.modelSessions,1);assert.equal(result.nativeTiming.environmentModelSessions,0);assert.equal(result.outcome,'ready');
});
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
  const result=await direct.call('agentos_environment_open',{request:'{}',website:false});assert.equal(result.state,'waiting');assert.equal(direct.waiting.browserLoginRequired,true);
  assert.equal((await direct.call('agentos_environment_open',{request:'{}',website:false})).state,'waiting');
  assert.equal(calls.length,1);await direct.close();
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

test('native explicit original goal passes the real continuation validator without broadening scope',async()=>{
 const {environmentContinuation}=await import('../src/shared/investigation-review.js');let opened=0;
 const direct=new InvestigationDirectTools({job:{...job,originalQuestion:'Read the original full report'},config:{},emit:async()=>{}},{post:async(route,body)=>{const query=body.result.environmentQuery;const decision=environmentContinuation({jobs:[]},job,query,body.result);assert.equal(body.result.investigation.goals[0].status,'open');if(!decision.continue)return{planned:false,job,diagnostic:{code:'REPEATED_TARGET',reason:decision.reason}};return{planned:true,job};},execute:async()=>{opened++;return{outcome:'needs_clarification',browserLoginRequired:true};}});
 const rejected=await direct.call('agentos_environment_open',{request:JSON.stringify({environmentId:'authorized',goalIds:['invented-goal']}),website:false});assert.equal(rejected.state,'not_opened');assert.equal(opened,0);
 const result=await direct.call('agentos_environment_open',{request:JSON.stringify({environmentId:'authorized',goalIds:['original-question']}),website:false});assert.equal(result.state,'waiting');assert.equal(opened,1);await direct.close();
});

test('closing a channel rejects a waiting or future planner choice rather than looping premature finish',async()=>{
 const c=new InvestigationToolChannel(),p=c.planner();const pending=p.next({tools:[{tool:'select'}],results:[]});const rejected=assert.rejects(pending,e=>e.code==='NATIVE_CHANNEL_CLOSED');await c.stop();await rejected;await assert.rejects(p.next({}),e=>e.code==='NATIVE_CHANNEL_CLOSED');await c.stop();
});
test('rejected premature close resumes current native source in the same model thread',async t=>{
 const directory=await temp(t),app=new EventEmitter();let turns=0,opens=0;app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async()=>({thread:{id:'same'}});
 const direct={job,sourceReceipts:[],channel:{},call:async name=>{if(name==='agentos_environment_open'){opens++;throw Error('Must not reopen while source remains active');}return{state:'tools',input:{tools:[{tool:'select'}],results:[{tool:'finish',error:{code:'PREMATURE_FINISH'}}]}};},close:async()=>{}};
 app.turn=async params=>{turns++;app.emit('notification',{method:'turn/started',params:{threadId:'same',turn:{id:'t'+turns}}});if(turns===1)return{text:JSON.stringify({outcome:'needs_clarification',finalMessage:'Need to finish source',environmentQuery:{environmentId:'same-source'}})};assert.match(params.input[0].text,/PREMATURE_FINISH/);direct.channel=null;return{text:JSON.stringify({outcome:'ready',finalMessage:'Actual original goal verified'})};};
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({}),bindToolCall:()=>{}});assert.equal(turns,2);assert.equal(opens,0);assert.equal(result.outcome,'ready');
});

test('native large result names the reader in its own store, legacy reader remains compatible',async()=>{
 const {ToolResultStore}=await import('../src/runner/tool-result-store.js');const store=new ToolResultStore({scope:'synthetic',readMaxCharacters:24000});for(const reader of ['read_tool_result','agentos_read_result']){const value={input:{tools:[{tool:'select',description:'x'.repeat(30000)}]}};const saved=await store.present('environment_open',value,24000,{persist:true,reader});assert.equal(saved.readerTool,reader);assert.ok(saved.note.includes(reader+'按resultRef'));let text='';for(let offset=0;offset<saved.totalCharacters;offset+=24000)text+=(await store.read({resultRef:saved.resultRef,offset,limit:24000})).text;assert.deepEqual(JSON.parse(text),value);assert.equal(saved.readerArguments.limit,24000);}
});

test('native source artifact reads validate original binding, content and path, including restored receipts',async t=>{
 const {documentDirectory}=await import('../src/shared/document-artifacts.js');const {mkdir}=await import('node:fs/promises');const directory=await temp(t),scope={policy:'isolated-environment-source-v1',environment:'sit',cacheKey:'cache',repositories:[{path:'service',branch:'sit',commit:'a'.repeat(40)}]},binding={jobId:job.id,questionId:job.questionId,profile:job.originProfile??job.agentProfile,projectId:job.projectId,environment:'sit',originalCacheKey:'cache',repositories:[{repository:'service',branch:'sit',commit:'a'.repeat(40)}]},relative='source-metadata/11111111-1111-4111-8111-111111111111.json',text=JSON.stringify({rows:[{commits:[{message:'actual saved merge'}]}]}),proof={policy:'source-commit-metadata-v1',artifact:relative,binding,resultHash:createHash('sha256').update(text).digest('hex')};const dir=await documentDirectory(directory,job.id);await mkdir(path.join(dir,'source-metadata'),{recursive:true});const file=path.join(dir,relative);await writeFile(file,text);
 for(const restored of [false,true]){const direct=new InvestigationDirectTools({job:{...job,...(restored?{context:[{result:{sourceHistory:proof}}]}:{})},sourceSync:scope,config:{dataDir:directory}});if(!restored)direct.sourceReceipts.push(proof);assert.equal(JSON.parse((await direct.readSourceMetadata({resultRef:relative})).text).rows[0].commits[0].message,'actual saved merge');await assert.rejects(direct.readSourceMetadata({resultRef:'../outside'}));await assert.rejects(direct.readSourceMetadata({resultRef:relative,limit:24001}));}
 const foreign=new InvestigationDirectTools({job:{...job,questionId:'foreign'},sourceSync:scope,config:{dataDir:directory}});foreign.sourceReceipts.push(proof);await assert.rejects(foreign.readSourceMetadata({resultRef:relative}),e=>e.code==='SOURCE_METADATA_ARTIFACT_SCOPE');const tampered=new InvestigationDirectTools({job,sourceSync:scope,config:{dataDir:directory}});tampered.sourceReceipts.push(proof);await writeFile(file,'changed');await assert.rejects(tampered.readSourceMetadata({resultRef:relative}),e=>e.code==='SOURCE_METADATA_ARTIFACT_CHANGED');
});

test('native bounded Unicode and escaped JSON reader pages never rewrap into recursive result references',async()=>{
 const {ToolResultStore}=await import('../src/runner/tool-result-store.js');const store=new ToolResultStore({scope:'reader-boundary',readMaxCharacters:24000,secrets:['synthetic-secret']});
 const value={items:Array.from({length:1800},(_,i)=>({id:String(i),text:'中文源码\"证据\n与已保存结果 synthetic-secret'}))},saved=await store.present('source',value,24000,{persist:true,reader:'agentos_read_result'});let restored='',offset=0,pages=0;
 while(offset!==null){const page=await store.read({resultRef:saved.resultRef,offset,limit:24000}),before=store.memory.size,shown=await presentNativeToolResult(store,'agentos_read_result',page);assert.equal(shown.resultRef,saved.resultRef);assert.equal(shown.text,page.text);assert.equal(shown.offset,offset);assert.equal(shown.resultLimited,undefined);assert.equal(store.memory.size,before);assert.ok(!shown.text.includes('synthetic-secret'));restored+=shown.text;offset=shown.nextOffset;pages++;}
 assert.ok(pages>1);assert.deepEqual(JSON.parse(restored),JSON.parse(JSON.stringify(value).replaceAll('synthetic-secret','[已隐藏]')));
 const metadataPage={resultRef:'source-metadata/a.json',offset:0,text:'证据'.repeat(12000),nextOffset:24000,sha256:'proof'};const shown=await presentNativeToolResult(store,'agentos_read_result',metadataPage);assert.deepEqual(shown,metadataPage);
});

test('published continue_environment and finish aliases retain validated same-thread peer handoff',async()=>{
 const first={...job,sourceEnvironment:'prd',environmentAccess:{environmentId:'first',tier:'prd'}};let chosen,executed=0;const routes=[];
 const direct=new InvestigationDirectTools({job:first,config:{},emit:async()=>{},workspace:'/fixed',sourceSync:{}},{
  execute:async(_j,_c,_e,{planner})=>{const p=await planner({kind:'mysql'});executed++;const choice=await p.next({tools:[{tool:executed===1?'continue_environment':'finish'}]});chosen=choice;if(executed===1){assert.equal(choice.tool,'continue_environment');return{outcome:'partial',finalMessage:'first data saved',nextEnvironmentQuery:{environmentId:'second',queryId:'investigate',parameters:['use saved keys']}};}assert.equal(choice.tool,'finish');return{outcome:'ready',finalMessage:'second data saved'};},
  post:async(route,body)=>{routes.push(route.split('/').at(-1));if(route.endsWith('/continuous-environment')){assert.equal(body.result.environmentQuery.environmentId,'second');return{planned:true,job:{...first,environmentAccess:{environmentId:'second',tier:'prd'}}};}return{job:{...first,environmentAccess:null}};}
 });
 await direct.openInitial();const next=await direct.call('agentos_environment_tool',{tool:'continue_environment',arguments:JSON.stringify({environmentId:'second',queryId:'investigate',parameters:['use saved keys']}),summary:'read peer'});
 assert.equal(next.state,'tools');assert.equal(next.previousSource.result.finalMessage,'first data saved');assert.deepEqual(routes,['continuous-environment-result','continuous-environment']);
 assert.equal((await direct.call('agentos_environment_tool',{tool:'finish',arguments:'{}',summary:'saved',complete:true})).state,'saved');assert.equal(executed,2);assert.equal(chosen.complete,true);await direct.close();
});

test('ordinary partial work continues in one live native app without repeated initial catalogs',async t=>{
 const directory=await temp(t),app=new EventEmitter(),events=[],requests=[];let turns=0,starts=0,closed=0,initials=0;
 app.start=async()=>starts++;app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>closed++;app.request=async(method,params)=>{requests.push(method);return{thread:{id:'original-live-thread'}};};
 const direct={job,sourceReceipts:[],openInitial:async()=>{initials++;return null;},close:async()=>{}};
 app.turn=async params=>{turns++;assert.equal(params.threadId,'original-live-thread');app.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:{id:'turn-'+turns}}});if(turns>1){assert.match(params.input[0].text,/当前会话|analysis_continuing/);assert.ok(!params.input[0].text.includes('original expensive prompt'));}return{text:JSON.stringify(turns<4?{outcome:'partial',finalMessage:'Artifact and actual evidence saved '+turns,investigation:{status:'continue',goals:[{id:'original',status:'open'}]}}:{outcome:'ready',finalMessage:'Verified original complete file'})};};
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'original expensive prompt',emit:async e=>events.push(e)},{app,direct,runtime:async()=>({}),bindToolCall:()=>{}});
 assert.equal(result.outcome,'ready');assert.equal(turns,4);assert.equal(starts,1);assert.equal(closed,1);assert.equal(initials,1);assert.deepEqual(requests,['thread/start']);assert.equal(result.nativeTiming.modelSessions,1);assert.equal(result.nativeTiming.hostContinuations,3);assert.equal(events.filter(e=>e.phase==='native_analysis_continuing').length,3);
});
for(const boundary of ['blocker','waiting','source'])test('native self continuation retains genuine '+boundary+' handoff',async t=>{
 const directory=await temp(t),app=new EventEmitter();let turns=0;app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async()=>({thread:{id:'bounded'}});
 const direct={job,sourceReceipts:[],close:async()=>{},...(boundary==='waiting'?{waiting:{outcome:'needs_clarification',browserLoginRequired:true,finalMessage:'actual login required'}}:{})};
 app.turn=async()=>{turns++;return{text:JSON.stringify({outcome:'partial',finalMessage:'preserved evidence',investigation:{status:'continue',...(boundary==='blocker'?{blocker:{kind:'permission',message:'real missing authorization'}}:{})},...(boundary==='source'?{sourceEnvironmentQuery:{environmentId:'explicit-sit'}}:{})})};};
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({}),bindToolCall:()=>{}});assert.equal(turns,1);assert.equal(result.nativeTiming.hostContinuations,0);if(boundary==='waiting')assert.equal(result.browserLoginRequired,true);if(boundary==='source')assert.equal(result.sourceEnvironmentQuery.environmentId,'explicit-sit');
});

test('pending trusted document rendering leaves the native loop for actual host generation',async t=>{
 const directory=await temp(t),app=new EventEmitter();let turns=0;app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async()=>({thread:{id:'render'}});app.turn=async()=>{turns++;return{text:JSON.stringify({outcome:'partial',finalMessage:'Render the actual requested file before inspection',investigation:{status:'continue'},documentRequests:[{format:'html',title:'Evidence',purpose:'original output',content:'<h1>Verified source</h1>'}]})};};const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct:{job,sourceReceipts:[],close:async()=>{}},runtime:async()=>({}),bindToolCall:()=>{}});assert.equal(turns,1);assert.equal(result.documentRequests.length,1);assert.equal(result.nativeTiming.hostContinuations,0);
});

test('new authorized cloud files materialize in the same native session and exclude foreign bindings',async()=>{
 const {materializeNativeInputs}=await import('../src/runner/native-investigation.js');
 const a={id:'ATT-cloud-'+'a'.repeat(64),type:'file',contentType:'application/test',source:{jobId:job.id,projectId:job.projectId,originProfile:job.originProfile,kind:'authorized-native-cloud-file',sha256:'b'.repeat(64)}};
 const options={job:{...job,artifactWorkspace:{directory:'/task/working'}},config:{}};let calls=0;
 const download=async(j,c,dir)=>{calls++;assert.deepEqual(j.attachments,[a]);assert.equal(dir,'/task/working');return[{id:a.id,path:'/task/working/input.pptx'}];};
 const out=await materializeNativeInputs({input:{results:[{result:{inputAttachment:a}},{result:{inputAttachment:a}},{result:{inputAttachment:{...a,id:'ATT-cloud-'+'c'.repeat(64),source:{...a.source,jobId:'foreign'}}}}]}},options,download);
 assert.equal(calls,1);assert.equal(out.localTaskInputs[0].path,'/task/working/input.pptx');
 for(const source of [{...a.source,originProfile:'other'},{...a.source,projectId:'other'},{...a.source,kind:'arbitrary-path'},{...a.source,sha256:'bad'}]){
  const v={inputAttachment:{...a,source}};assert.equal(await materializeNativeInputs(v,options,download),v);
 }
 assert.equal(calls,1);
 await assert.rejects(materializeNativeInputs({inputAttachment:a},options,async()=>{throw Error('digest mismatch');}),/digest mismatch/);
});
test('mislabelled clarification with explicit executable next step keeps same native session',async t=>{
 const directory=await temp(t),app=new EventEmitter();let turns=0;app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async()=>({thread:{id:'same-file-session'}});
 app.turn=async()=>({text:JSON.stringify(++turns===1?{outcome:'needs_clarification',finalMessage:'Template downloaded; load and render next',investigation:{status:'continue',blocker:null,nextStep:'Read the already authorized local file and render'}}:{outcome:'ready',finalMessage:'Original file delivered'})});
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct:{job,sourceReceipts:[],close:async()=>{}},runtime:async()=>({})});
 assert.equal(turns,2);assert.equal(result.nativeTiming.modelSessions,1);assert.equal(result.outcome,'ready');
});

test('yielded host calls finish once and their durable result returns before accepting a final answer',async t=>{
 const directory=await temp(t),app=new EventEmitter();let turns=0,call,executed=0,toolPromise;
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.close=async()=>{};app.request=async()=>({thread:{id:'yielded'}});
 const direct={job,sourceReceipts:[],close:async()=>{},call:async()=>{executed++;await new Promise(r=>setTimeout(r,40));return {state:'saved',actualEvidence:'fixed-original-source'};}};
 app.turn=async params=>{turns++;app.emit('notification',{method:'turn/started',params:{threadId:'yielded',turn:{id:'turn-'+turns}}});
  if(turns===1){toolPromise=call({threadId:'yielded',turnId:'turn-1',namespace:null,callId:'original-call',tool:'agentos_source_history',arguments:{query:'{}'}});return{text:JSON.stringify({outcome:'partial',finalMessage:'Tool still running',investigation:{status:'wait',blocker:{kind:'unavailable',needed:'wait for tool'}}})};}
  assert.match(params.input[0].text,/fixed-original-source/);assert.equal(executed,1);return{text:JSON.stringify({outcome:'ready',finalMessage:'Reviewed actual completed tool evidence'})};
 };
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({}),bindToolCall:c=>call=c});
 await toolPromise;assert.equal(executed,1);assert.equal(turns,2);assert.equal(result.nativeTiming.hostContinuations,1);assert.equal(result.outcome,'ready');
});

test('controller grant refresh preserves trusted local artifact workspace for a later cloud input',async t=>{
 const directory=await temp(t),app=new EventEmitter();let handler,downloads=0,receipt;
 const original={...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}};
 const input={id:'ATT-cloud-'+'d'.repeat(64),type:'file',source:{jobId:job.id,projectId:job.projectId,originProfile:job.originProfile,kind:'authorized-native-cloud-file',sha256:'e'.repeat(64)}};
 // The controller serializes durable job state, not this Runner's local capability.
 const direct={job,sourceReceipts:[],call:async()=>({inputAttachment:input}),close:async()=>{}};
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.request=async()=>({thread:{id:'cloud-refresh'}});app.close=async()=>{};
 app.turn=async()=>{app.emit('notification',{method:'turn/started',params:{threadId:'cloud-refresh',turn:{id:'turn'}}});receipt=await handler({threadId:'cloud-refresh',turnId:'turn',namespace:null,callId:'new-cloud-input',tool:'agentos_environment_tool',arguments:{tool:'read_cloud_document',arguments:'{}',summary:'original requested template'}});return{text:JSON.stringify({outcome:'ready',summary:'fixture complete',finalMessage:'fixture complete'})};};
 await runNativeInvestigation({job:original,config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({}),bindToolCall:h=>handler=h,downloadInputs:async(j,_c,dir)=>{downloads++;assert.equal(dir,directory);assert.deepEqual(j.attachments,[input]);return[{id:input.id,path:dir+'/template.pptx'}];}});
 assert.equal(receipt.success,true);assert.equal(downloads,1);assert.match(receipt.contentItems[0].text,/localTaskInputs/);
});

test('a proposed log wait rechecks the current authorized catalog and uses the tools within the same session',async t=>{
 const directory=await temp(t),app=new EventEmitter(),phases=[];
 const raw={outcome:'partial',finalMessage:'已核对状态，仍需查询日志',investigation:{status:'wait',blocker:{kind:'unavailable',needed:'读取服务端日志'}}};
 let turns=0,reads=0,invoke;
 const direct={job,sourceReceipts:[],untriedLogSources:async()=>[{environmentId:'prd-logs',queryId:'investigate'}],
  call:async(name,args)=>{assert.equal(name,'agentos_environment_open');assert.equal(JSON.parse(args.request).environmentId,'prd-logs');reads++;return {state:'saved'};},close:async()=>{}};
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.request=async()=>({thread:{id:'logs-thread'}});app.close=async()=>{};
 app.turn=async input=>{
  if(++turns===1)return{text:JSON.stringify(raw)};
  assert.match(input.input[0].text,/尚未实际查过.*prd-logs/s);
  app.emit('notification',{method:'turn/started',params:{threadId:'logs-thread',turn:{id:'log-evidence'}}});
  await invoke({threadId:'logs-thread',turnId:'log-evidence',namespace:null,callId:'log-read',tool:'agentos_environment_open',arguments:{request:'{"environmentId":"prd-logs"}',website:false}});
  return{text:JSON.stringify(raw)};
 };
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async e=>phases.push(e.phase)},{app,direct,runtime:async()=>({}),bindToolCall:fn=>invoke=fn});
 assert.equal(result.outcome,'partial');assert.equal(turns,2);assert.equal(reads,1);assert.equal(result.nativeTiming.modelSessions,1);
 assert.ok(phases.includes('native_analysis_continuing'));
});

test('catalog fallback selects only the original project and tier and skips a source with a real log lookup',async()=>{
 const app={applicationId:'application-a',groups:[{groupId:'group-a'}]},second={applicationId:'application-b',groups:[{groupId:'group-b'}]},query={applications:[app,second],logApplications:[app.applicationId,second.applicationId]};
 const source=(projectId,tier,q=query)=>({kind:'tsf',projectId,tier,queries:{investigate:q}});
 const endpoints={right:source('a','uat'),prd:source('a','prd'),peer:source('b','uat'),metadata:source('a','uat',{applications:[app]}),archived:source('a','uat',{...query,logReadWindow:{startTime:'older'}})};
 const result={investigation:{status:'wait',blocker:{kind:'unavailable',needed:'日志记录需要核对'}}};
 const scoped={...job,sourceEnvironment:'sit',originalQuestion:'接口为何返回错误'};
 const tools=new InvestigationDirectTools({job:scoped},{loadEnvironments:async()=>({environments:endpoints})});
 assert.deepEqual((await tools.untriedLogSources(result)).map(x=>x.environmentId),['right']);
 tools.job={...scoped,context:[{kind:'environment_result',result:{environmentEvidence:{environmentId:'right'},toolResultCatalog:[{tool:'search_logs'}]}}]};
 assert.deepEqual(await tools.untriedLogSources(result),[]);
 tools.job={...scoped,originalQuestion:'application-b 的报错',context:[{kind:'environment_result',result:{environmentEvidence:{environmentId:'right'},toolResultCatalog:[{tool:'search_logs',applicationId:'application-a'}]}}]};
 assert.deepEqual((await tools.untriedLogSources(result))[0].applications.map(a=>a.applicationId),['application-b']);
 tools.job={...scoped,originalQuestion:'只看代码，不要查日志'};
 assert.deepEqual(await tools.untriedLogSources(result),[]);
 assert.deepEqual(await tools.untriedLogSources({...result,investigation:{status:'wait',blocker:{kind:'approval',needed:'待核对日志'}}}),[]);
});

test('host login wait discards a stale model environment handoff',async t=>{
 const directory=await temp(t),app=new EventEmitter();
 const waiting={outcome:'needs_clarification',browserLoginRequired:true,browserCheckpoint:{saved:true},finalMessage:'login'};
 const direct={job,sourceReceipts:[],waiting,openInitial:async()=>({state:'waiting',result:waiting}),call:async()=>assert.fail('must not reopen while waiting'),close:async()=>{}};
 app.start=async()=>{};app.readAccount=async()=>({account:{type:'chatgpt'}});app.request=async()=>({thread:{id:'wait-thread'}});app.close=async()=>{};
 app.turn=async()=>({text:JSON.stringify({outcome:'needs_clarification',finalMessage:'change source',
  environmentQuery:{environmentId:'db-next'},websiteQuery:{tier:'prd'},sourceEnvironmentQuery:{environmentId:'sit'}})});
 const result=await runNativeInvestigation({job:{...job,artifactWorkspace:{directory,profile:'aos_artifact_01234567890123456789'}},config:{dataDir:directory},workspace:directory,prompt:'fixture',emit:async()=>{}},{app,direct,runtime:async()=>({})});
 assert.equal(result.browserLoginRequired,true);
 assert.deepEqual(result.browserCheckpoint,{saved:true});
 assert.equal(result.environmentQuery,null);assert.equal(result.websiteQuery,null);assert.equal(result.sourceEnvironmentQuery,null);
 assert.equal(result.finalMessage,'login');
});
