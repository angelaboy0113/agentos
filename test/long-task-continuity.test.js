import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {planQuery} from '../src/shared/environment-access.js';
import {renewReadPlan} from '../src/shared/read-plan-renewal.js';
import {createControlPlane} from '../src/control-plane/server.js';
import {CONTROL_PROTOCOL} from '../src/shared/control-receipts.js';
import {controlPost} from '../src/runner/control-client.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
import {ToolResultStore} from '../src/runner/tool-result-store.js';
import {TaskDatasetStore} from '../src/runner/task-dataset-store.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {createEnvironmentTools,selectStatement,aggregateStatement,groupedDatasetStatement,collectValuesStatement} from '../src/runner/environment-tools.js';
import {buildSourceQueryContext,sourceQueryTools} from '../src/runner/source-query-context.js';
import {createHash} from 'node:crypto';
import {reportReviewEvidence} from '../src/shared/report-inspection.js';
import {validateReportFiles} from '../src/shared/report-files.js';

const q={reviewed:true,mode:'investigate',description:'Synthetic scoped reads',tables:['*'],parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,timeoutMs:1000,exportMaxRows:'all',exportTimeoutMs:1000};
const e={projectId:'p',tier:'uat',kind:'mysql',host:'fake',port:3306,database:'demo',credentialRef:'fake',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_user']},queries:{investigate:q}};
const cfg={version:1,environments:{db:e}},actor={projectId:'p',profile:'owner',senderId:'ou_user'};
const grant=(now=Date.now())=>({...planQuery(cfg,{environmentId:'db',queryId:'investigate',parameters:['Synthetic read scope']},'p',actor,now),startedAt:new Date(now).toISOString()});
async function temp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'long-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('same read scope renews beyond many windows but revocation, wrong system and changed parameters cannot expand it',()=>{
 let p=grant();const start=p.startedAt;
 for(let n=1;n<=16;n++)p=renewReadPlan(cfg,p,actor,Date.now()+n*900001);
 assert.equal(p.startedAt,start);assert.equal(p.environmentId,'db');assert.deepEqual(p.parameters,['Synthetic read scope']);
 assert.throws(()=>renewReadPlan(cfg,p,{...actor,projectId:'other'}));
 assert.throws(()=>renewReadPlan(cfg,{...p,parameters:['different']},actor));
 assert.throws(()=>renewReadPlan({version:1,environments:{db:{...e,ownerOpenIdsByProfile:{owner:[]}}}},p,actor));
 assert.throws(()=>renewReadPlan({version:1,environments:{db:{...e,tier:'prd'}}},p,actor));
});

test('active renewal HTTP is durable and idempotent; a cancelled or foreign lease never renews',async t=>{
 const dir=await temp(t),previous=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'state.json'),runnerToken:'synthetic',projects:{projects:{p:{}},chatProjectMap:{}},agents:{agents:{}},feishuClient:{enabled:false},conversationResponder:async()=>({action:'reply',reply:''})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.conversations.stop();await app.cards.stop();if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;});
 const p=grant(Date.now()-16*60000),lease={id:'lease',runnerId:'r',expiresAt:new Date(Date.now()+120000).toISOString()};
 await app.store.transact(s=>s.jobs.push({id:'job',status:'running',stage:'developer',taskIntent:'analysis',projectId:'p',originProfile:'owner',senderId:'ou_user',environmentAccess:p,events:[],lease}));
 const route='/api/v1/jobs/job/environment-renew',url='http://127.0.0.1:'+app.server.address().port,body={leaseId:'lease',runnerId:'r',scopeHash:p.scopeHash},id=randomUUID(),headers={'authorization':'Bearer synthetic','content-type':'application/json','x-agentos-request-id':id,'x-agentos-control-protocol':CONTROL_PROTOCOL};
 const request=()=>fetch(url+route,{method:'POST',headers,body:JSON.stringify(body)});
 const first=await request();assert.equal(first.status,200);const one=await first.json(),second=await request();assert.equal(second.status,200);assert.equal((await second.json()).plan.scopeHash,one.plan.scopeHash);
 assert.equal((await app.store.getJob('job')).events.filter(x=>x.type==='environment_scope_renewed').length,1);
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{db:{...e,tier:'prd'}}}));
 await assert.rejects(controlPost({serverUrl:url,runnerToken:'synthetic'},route,{...body,scopeHash:one.plan.scopeHash}),error=>error.statusCode===403);
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 await assert.rejects(controlPost({serverUrl:url,runnerToken:'synthetic'},route,{...body,leaseId:'foreign'}),error=>error.statusCode===409);
 await app.store.transact(s=>{s.jobs[0].status='cancelling';});
 const stale=await request();assert.equal(stale.status,409);
 const queued=grant(Date.now()-30*60000);delete queued.startedAt;
 await app.store.transact(s=>s.jobs.push({id:'queued',status:'running',stage:'developer',taskIntent:'analysis',projectId:'p',originProfile:'owner',senderId:'ou_user',environmentAccess:queued,events:[],lease:{...lease,id:'queued-lease'}}));
 const claimed=await app.store.claimEnvironment('queued',{leaseId:'queued-lease',runnerId:'r'});assert.ok(Date.parse(claimed.expiresAt)>Date.now());assert.ok(claimed.startedAt);
 await assert.rejects(app.store.claimEnvironment('queued',{leaseId:'queued-lease',runnerId:'r'}),/QUERY_ALREADY_STARTED/);
});

test('long investigator renews scope after a slow tool/model and never repeats completed reads',async t=>{
 t.mock.timers.enable({apis:['Date']});const p=grant();let calls=0,renewals=0,turns=0;
 const result=await investigateEnvironment(p,async()=>{},{load:async()=>cfg,credential:async()=>({}),renewPlan:async old=>{renewals++;return renewReadPlan(cfg,old,actor);},
  tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{calls++;t.mock.timers.tick(16*60000);return tool==='connection'?{}:{rows:[{id:'kept'}]};},close:async()=>{}}),
  planner:async()=>({next:async()=>++turns===1?{tool:'select',arguments:'{}'}:{tool:'finish',complete:true,summary:'Evidence retained'},close:async()=>{}})});
 assert.ok(renewals>=2);assert.equal(calls,2);assert.equal(result.partial,false);assert.equal(result.rows[0].id,'kept');
});

test('large parameters and full results become resumable pages instead of stopping the investigator',async t=>{
 const directory=await temp(t),p=grant();let turns=0,queries=0;
 const result=await investigateEnvironment(p,async()=>{},{load:async()=>cfg,credential:async()=>({password:'synthetic-secret'}),exportDirectory:directory,
  tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{if(tool==='connection')return{};queries++;return {rows:[{text:'内容'.repeat(18000)+'synthetic-secret'}],complete:true,partial:false,optional:undefined};},close:async()=>{}}),
  planner:async()=>({next:async input=>{turns++;if(turns===1)return{tool:'select',arguments:JSON.stringify({keys:Array.from({length:3000},(_,n)=>String(n))})};const stored=input.results.find(x=>x.result?.resultStored)?.result;assert.ok(stored);assert.equal(stored.partial,false);if(turns===2)return{tool:'read_tool_result',arguments:JSON.stringify({resultRef:stored.resultRef})};return{tool:'finish',complete:true,summary:'Full evidence saved'};},close:async()=>{}})});
 assert.equal(queries,1);assert.equal(result.partial,false);
});

test('stored large results resume across workers, preserve nulls and partial flags, reject tampering/scope/symlinks',async t=>{
 const directory=await temp(t),s=new ToolResultStore({directory,scope:'systemA-sit',secrets:['private-key']});
 const original={text:'大'.repeat(20000)+'private-key',rows:[{value:null}],partial:true,complete:false};const out=await s.present('schema',original);assert.equal(out.partial,true);assert.equal(out.complete,false);
 const resumed=new ToolResultStore({directory,scope:'systemA-sit'});assert.equal((await resumed.list()).items[0].resultRef,out.resultRef);let text='',offset=0;
 for(;;){const page=await resumed.read({resultRef:out.resultRef,offset});text+=page.text;if(page.nextOffset===null)break;offset=page.nextOffset;}
 assert.equal(JSON.parse(text).rows[0].value,null);assert.ok(!text.includes('private-key'));assert.equal(JSON.parse(text).partial,true);
 await assert.rejects(new ToolResultStore({directory,scope:'systemB-prd'}).read({resultRef:out.resultRef}));
 const file=path.join(directory,'tool-results',out.resultRef+'.json'),saved=JSON.parse(await readFile(file));saved.text+='x';await writeFile(file,JSON.stringify(saved));await assert.rejects(resumed.read({resultRef:out.resultRef}));
 await rm(file);await symlink(path.join(directory,'outside'),file);await assert.rejects(resumed.read({resultRef:out.resultRef}));
});

test('old complete datasets restore under current scope without refreshing their acquisition timestamp',async t=>{
 const root=await temp(t),s=new TaskDatasetStore(root,'systemA-sit'),ref='dataset-'+randomUUID(),readAt=new Date(Date.now()-45*86400000).toISOString();
 await s.save(ref,{complete:true,columns:['id'],rows:[{id:'original'}]},'old-snapshot',readAt);
 assert.equal((await s.get(ref)).readAt,readAt);assert.equal((await s.list())[0].historical,true);
 const d=new ReportDatasets({maxRows:'all',directory:root,scope:'systemA-sit'});const restored=await d.inspect({datasetRef:ref});assert.equal(restored.historical,true);assert.equal(restored.readAt,readAt);
 await assert.rejects(new TaskDatasetStore(root,'systemB-sit').get(ref));
});

test('complete SQL paging and local work can exceed the old whole-tool deadline while requests keep individual timeouts',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const root=await temp(t);let pageCalls=0;
 const connection={query:async input=>{assert.equal(input.timeout,1000);return input.sql.startsWith('SHOW GRANTS')?[[{grant:'GRANT SELECT ON demo.* TO reader'}]]:[[]];},execute:async statement=>{
  assert.equal(statement.timeout,1000);if(statement.sql.includes('information_schema'))return[[{table_name:'objects',column_name:'id',data_type:'varchar',engine:'InnoDB'}]];
  t.mock.timers.tick(800);pageCalls++;const m=statement.sql.match(/LIMIT (\d+) OFFSET (\d+)/),offset=Number(m[2]),size=Number(m[1]);return [Array.from({length:Math.min(size,Math.max(0,1100-offset))},(_,n)=>({id:String(offset+n),amount:'1'}))];
 },rollback:async()=>{},destroy:()=>{}};
 const tools=await createEnvironmentTools(e,q,{},{exportDirectory:root,mysql:{createConnection:async()=>connection}});t.after(()=>tools.close());await tools.run('schema',{table:'objects'});
 const out=await tools.run('group_dataset',{table:'objects',groupColumns:['id'],aggregates:[{op:'count',as:'amount'}],filters:[]});assert.equal(out.rowCount,1100);assert.equal(out.complete,true);assert.ok(pageCalls>=3);
});

test('wide parameterized reads, many metrics and complete cohort keys do not require arbitrary SQL',()=>{
 const columns=Array.from({length:160},(_,n)=>'f'+n),tables=new Map([['objects',columns]]),types=new Map([['objects',new Map(columns.map(c=>[c,'decimal']))]]);
 const filters=[{column:'f0',op:'in',value:Array.from({length:3000},(_,n)=>'id'+n)},{column:'f1',op:'=',value:'长'.repeat(2000)}];
 const selected=selectStatement({table:'objects',columns,filters},tables,q);assert.equal(selected.columns.length,160);assert.equal(selected.params.length,3001);assert.ok(!selected.sql.includes('长'));
 const aggregates=Array.from({length:20},(_,n)=>({op:'sum',column:'f0',as:'m'+n}));assert.equal(aggregateStatement({table:'objects',aggregates,filters:[]},tables,types,q).columns.length,20);
 assert.equal(groupedDatasetStatement({table:'objects',groupColumns:columns,aggregates,filters:[]},tables,types,q).columns.length,180);
 assert.doesNotMatch(collectValuesStatement({table:'objects',columns,filters:[]},tables,q).sql,/LIMIT/);
 assert.throws(()=>selectStatement({table:'foreign',columns:['f0'],filters:[]},tables,q));
});

test('large verified source and long lines are paged without dropping files beyond the initial eight excerpts',async t=>{
 const root=await temp(t),files=[];
 for(let n=0;n<10;n++){const name='source'+n+'.java',body=n===9?'x'.repeat(350000):'verified\nsource';await writeFile(path.join(root,name),body);files.push({kind:'code',path:name,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});}
 const context=await buildSourceQueryContext({workspace:root,sourceSync:{workspace:root},handoffGate:{passed:true},verifiedArtifacts:files});assert.equal(context.sources.length,10);assert.equal(context.sources[9].initialExcerptDeferred,true);
 const tools=sourceQueryTools(context);let startLine=1,textOffset=0,total=0;
 for(;;){const page=await tools.run('read_source_evidence',{ref:context.sources[9].ref,startLine,textOffset});total+=page.lines.reduce((n,l)=>n+l.text.length,0);if(page.nextLine===null)break;startLine=page.nextLine;textOffset=page.nextTextOffset??0;}
 assert.equal(total,350000);
});

test('complete SQL cohort collection includes rows beyond1000 and remains parameterized when reused',async t=>{
 let bound=0;const tools=await createEnvironmentTools(e,q,{},{exportDirectory:await temp(t),mysql:{createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async s=>{
  if(s.sql.includes('information_schema'))return[[{table_name:'objects',column_name:'id',data_type:'varchar',engine:'InnoDB'}]];
  if(s.sql.startsWith('SELECT DISTINCT')){assert.doesNotMatch(s.sql,/LIMIT/);return[Array.from({length:1107},(_,n)=>({id:String(n)}))];}
  bound=(s.sql.match(/\?/g)??[]).length;return[[{n:'1107'}]];
 },rollback:async()=>{},destroy:()=>{}})}});t.after(()=>tools.close());
 await tools.run('schema',{table:'objects'});const set=await tools.run('collect_values',{table:'objects',columns:['id'],filters:[]});assert.equal(set.valueCount,1107);assert.equal(set.truncated,false);
 await tools.run('aggregate',{table:'objects',aggregates:[{op:'count',as:'n'}],filters:[{column:'id',op:'in_set',value:set.setRef}]});assert.equal(bound,1107);
});

test('twenty-five real verified reports all register and receive independent file inspection without a hidden twenty-file ceiling',async t=>{
 const root=await temp(t),directory=path.join(root,'exports','JOB-many'),d=new ReportDatasets({maxRows:'all',directory,scope:'many'});
 const p=await d.collect({sql:'SELECT independent_objects',params:[],columns:['id']},async()=>[[{id:'one'}]]),files=[];
 for(let n=0;n<25;n++){
  const draft=await d.compose({sources:[{name:'s1',datasetRef:p.datasetRef,keyColumn:'id'}],columns:[{label:'id',value:{op:'field',source:'s1',column:'id'}}]});
  const out=await d.finalize({datasetRef:draft.datasetRef,requirement:'Explicit complete object export',expectedColumns:draft.columns,scopeEvidence:'Independent complete object source',populationRef:p.datasetRef,populationKey:'id',columnRules:[{label:'id',definition:'Original object identity',evidence:'Independent full object population'}],checks:[]});files.push(out.exportFile);
 }
 assert.equal((await validateReportFiles(root,'JOB-many',files)).length,25);const review=await reportReviewEvidence(root,{id:'JOB-many',reportFiles:files});assert.equal(review.relatedReports.length,24);assert.ok(review.relatedReports.every(r=>r.status==='verified'));
 await writeFile(path.join(directory,files[5].filename),'tampered');await assert.rejects(validateReportFiles(root,'JOB-many',files));
});

test('malformed tool JSON is corrected locally instead of losing already gathered evidence',async()=>{
 let turns=0,reads=0;const result=await investigateEnvironment(grant(),async()=>{},{load:async()=>cfg,credential:async()=>({}),tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{if(tool==='select')reads++;return{rows:[{id:'retained'}]};},close:async()=>{}}),planner:async()=>({next:async()=>++turns===1?{tool:'select',arguments:'{invalid'}:turns===2?{tool:'select',arguments:'{}'}:{tool:'finish',complete:true,summary:'Corrected current input'},close:async()=>{}})});
 assert.equal(reads,1);assert.equal(result.partial,false);assert.ok(result.toolInputErrors.some(x=>x.code==='TOOL_ARGUMENTS'&&x.resolved));
});
