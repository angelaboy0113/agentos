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
