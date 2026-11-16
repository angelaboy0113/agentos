import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';
import {prepareConnectedReadScope}from'../src/shared/connected-read-scope.js';
import {loadEnvironments,planQuery}from'../src/shared/environment-access.js';
import mongo from'../src/runner/ssh-mongo-worker.cjs';
const query={mode:'investigate',reviewed:true,description:'scoped evidence',parameters:[{name:'purpose',type:'string'}],collections:['Task'],requiredFilters:[{column:'id',op:'=',type:'string',value:'one'}],maxRows:20,timeoutMs:1000};
const entry=(projectId,tier)=>({kind:'mongodb',projectId,tier,credentialRef:'existing',host:'database.example',port:27017,database:'business',authSource:'admin',membersRead:false,ownerOpenIdsByProfile:{bot:['ou_owner']},transport:{mode:'ssh-remote-execution',host:'jump.example',port:22,credentialRef:'jump',knownHostsFile:'/tmp/known_hosts'},queries:{investigate:structuredClone(query)}});
test('standing connected read scope adds discoverable business collections without mutating old record grants or crossing projects and tiers',async t=>{
 const config={version:1,environments:{a:entry('alpha','prd'),duplicate:entry('alpha','prd'),test:entry('alpha','uat'),b:entry('beta','prd'),internal:{...entry('alpha','prd'),database:'admin'}}},before=structuredClone(config);
 const result=prepareConnectedReadScope(config,{version:1,projects:['alpha'],tiers:['prd']});assert.deepEqual(config,before);
 assert.equal(result.audit.length,1);assert.equal(result.runtimeGrantChanged,false);assert.deepEqual(result.config.environments.a.queries.investigate,query);assert.deepEqual(result.config.environments.a.queries.connected_read.collections,['*']);assert.equal(result.config.environments.a.queries.connected_read.requiredFilters,undefined);
 for(const key of ['duplicate','test','b','internal'])assert.deepEqual(result.config.environments[key],before.environments[key]);
 const dir=await mkdtemp(path.join(os.tmpdir(),'connected-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');await writeFile(file,JSON.stringify(result.config));const loaded=await loadEnvironments(file);
 const request={environmentId:'a',queryId:'connected_read',parameters:['inspect current task evidence']};assert.equal(planQuery(loaded,request,'alpha',{profile:'bot',senderId:'ou_member'}).tier,'prd');assert.throws(()=>planQuery(loaded,request,'beta',{profile:'bot',senderId:'ou_member'}));
 assert.equal(mongo.permitted('TerminalDetail',['*']),true);for(const name of ['system.users','account_passwords','$cmd'])assert.equal(mongo.permitted(name,['*']),false);assert.equal(mongo.field('credentials.password'),false);assert.throws(()=>mongo.validateArgs({collections:['Task'],pipeline:[{$out:'other'}]},['*']));
 assert.deepEqual(mongo.scopedArgs({collections:['Task'],filters:[]},query).filters,query.requiredFilters);
});
test('existing full database read is reused and no discovery-only query grants another database',()=>{
 const sql={...entry('alpha','uat'),kind:'mysql',database:'sales',queries:{investigate:{...query,tables:['*']}}};delete sql.queries.investigate.collections;delete sql.queries.investigate.requiredFilters;
 const config={version:1,environments:{sql}},result=prepareConnectedReadScope(config,{version:1,projects:['alpha'],tiers:['uat']});assert.deepEqual(result.config,config);assert.equal(result.audit[0].action,'reuse-existing-database-read');
 for(const policy of [null,{}, {version:1,projects:['alpha'],tiers:['production']},{version:1,projects:[],tiers:['prd']}])assert.throws(()=>prepareConnectedReadScope(config,policy));
});
