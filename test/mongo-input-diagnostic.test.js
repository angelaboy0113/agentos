import test from 'node:test';import assert from 'node:assert/strict';import {mongoInputDiagnostic} from '../src/runner/mongo-input-diagnostic.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
test('typed BSON errors identify failing filter position without printing input values or raw expressions',()=>{
 const s=mongoInputDiagnostic({filters:[{column:'state',op:'=',type:'string',value:'ok'},{column:'at',op:'>=',type:'date',value:'PRIVATE_BAD_DATE'}]},'MONGO_VALUE_TYPE');assert.match(s,/filters\[1\]/);assert.match(s,/ISO时间/);assert.doesNotMatch(s,/PRIVATE_BAD_DATE/);
 for(const code of ['MONGO_ARGUMENTS','MONGO_FIELDS','MONGO_AGGREGATE','MONGO_DISTINCT_COMBINATION'])assert.ok(mongoInputDiagnostic({},code).length>30);
});
test('new window tool is exposed on SQL and Mongo without enabling joins or arbitrary expressions in Mongo',async()=>{
 for(const kind of ['mysql','mongodb']){const t=await createEnvironmentTools({kind,host:'fake',database:'db'},{tables:['*'],collections:['*'],maxRows:20,exportMaxRows:'all',timeoutMs:1000},{username:'fake',password:'fake'});try{assert.ok(t.spec.some(s=>s.tool==='window_dataset'));if(kind==='mongodb')assert.ok(!t.spec.some(s=>s.tool==='linked_group_dataset'));}finally{await t.close();}}
});

test('complete dataset evidence does not become an empty-query claim when only references are returned',async()=>{
 const {presentEnvironmentResult}=await import('../src/runner/environment-result-presentation.js');
 const result=presentEnvironmentResult({kind:'mysql',tier:'prd',description:'query'},{partial:false,rows:[],summary:'已保存完整结果',evidence:{completeDatasetCount:1,businessQueryCount:1,readAt:new Date().toISOString()}});
 assert.doesNotMatch(result.summary,/本次未返回记录/);assert.doesNotMatch(result.metadata,/返回 0 条/);assert.match(result.summary,/完整数据集/);
});
