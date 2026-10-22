import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,compactCatalog} from '../src/shared/environment-access.js';
import {fitContext,estimateTokens} from '../src/control-plane/memory.js';
test('many database contracts compact losslessly without removing a target or changing its scope',()=>{
 const environments={};
 for(let i=0;i<40;i++)environments['test_'+i]={projectId:'p',tier:i%2?'uat':'prd',kind:'mysql',queries:{investigate:{mode:'investigate',description:'当前业务库'+i+'受控查询与完整导出',parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,exportMaxRows:'all',tables:['table_'+(i%2)]}}};
 environments.foreign={...environments.test_0,projectId:'other'};
 const full=catalog({environments},'p'),compact=compactCatalog(full);
 assert.equal(compact.environments.length,40);assert.equal(Object.keys(compact.queryProfiles).length,2);
 for(const [i,e] of compact.environments.entries()){
  assert.equal(e.environmentId,full[i].environmentId);assert.equal(e.tier,full[i].tier);
  assert.deepEqual(e.queries.map(({profileId,...q})=>({...q,...compact.queryProfiles[profileId]})),full[i].queries);
 }
 assert.ok(estimateTokens(compact)<estimateTokens(full)*0.65);
 const input={message:'export recent orders',history:[],jobs:[],environmentCatalog:compact,memory:{summary:{items:[]},matches:[]}};
 assert.equal(fitContext(input).environmentCatalog.environments.length,40);
});

test('resumed analysis refreshes current capability contracts instead of remembering an obsolete tool gap',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const path=await import('node:path'),os=await import('node:os');const {buildPrompt}=await import('../src/runner/codex-executor.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'catalog-resume-')),prev=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(prev===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=prev;await rm(dir,{recursive:true,force:true});});
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{latest_source:{kind:'mysql',projectId:'p',tier:'uat',host:'db.test',port:3306,database:'demo',credentialRef:'never-print',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_owner']},queries:{investigate:{reviewed:true,description:'read',mode:'investigate',tables:['*'],parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,timeoutMs:1000}}}}}));
 const job={taskIntent:'analysis',stage:'developer',questionId:'q',projectId:'p',context:[{stage:'developer',result:{threadId:'thread',workspace:'/snapshot'}}]};
 const prompt=await buildPrompt(job,{}, {instruction:'unused',metadata:{}},{workspace:'/snapshot'},[],'/snapshot');
 assert.match(prompt,/latest_source/);assert.match(prompt,/database_clock/);assert.doesNotMatch(prompt,/never-print/);
});

test('routing phase keeps every target and parameter contract while execution scopes remain in the full catalog',async()=>{
 const {routingCatalog}=await import('../src/shared/environment-access.js');const config={environments:{}};
 for(let i=0;i<80;i++)config.environments['db_'+i]={projectId:'p',tier:i%2?'uat':'prd',kind:'mysql',queries:{investigate:{mode:'investigate',description:'业务库只读调查与完整导出',parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,exportMaxRows:'all',tables:['table_'+i]}}};
 const full=catalog(config,'p'),thin=routingCatalog(full);assert.equal(thin.environments.length,80);assert.equal(Object.keys(thin.queryProfiles).length,1);
 for(const [i,e] of thin.environments.entries()){assert.equal(e.environmentId,full[i].environmentId);assert.deepEqual(thin.queryProfiles[thin.querySets[e.querySetId][0].profileId].parameters,full[i].queries[0].parameters);assert.deepEqual(full[i].queries[0].scope.tables,['table_'+i]);}
 assert.ok(estimateTokens(thin)<estimateTokens(compactCatalog(full))*0.8);
});

test('budget diagnostics contain only numeric section sizes, not request contents',()=>{
 const message='PRIVATE_SENTINEL'.repeat(3000);
 assert.throws(()=>fitContext({message,history:[],jobs:[],memory:{}}),error=>{assert.ok(error.contextBudget.estimated>error.contextBudget.limit);assert.equal(error.contextBudget.sections.message,Buffer.byteLength(message));assert.doesNotMatch(JSON.stringify(error.contextBudget),/PRIVATE_SENTINEL/);return true;});
});
