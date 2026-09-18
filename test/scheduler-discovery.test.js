import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerConfiguration} from '../src/runner/config-endpoints.js';
import {createEnvironmentTools} from '../src/runner/environment-tools.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
import {planQuery} from '../src/shared/environment-access.js';
import {handoffContext} from '../src/runner/harness.js';
const source=`infra:
  host: jobs.example
xxl:
  job:
    enabled: true
    accessToken: NEVER_EXPOSE_TOKEN
    admin:
      addresses: http://\${infra.host}:8080/xxl-job-admin
    executor:
      appname: task-uat
      logpath: /private/logs
password: NEVER_EXPOSE_PASSWORD
`;
test('scheduler YAML resolves local placeholders and publishes only named runtime fields',()=>{
 const r=schedulerConfiguration(source);
 assert.deepEqual(r.websites,[{kind:'xxl-job',key:'xxl.job.admin.addresses',url:'http://jobs.example:8080/xxl-job-admin'}]);
 assert.deepEqual(r.entries,[{key:'xxl.job.enabled',value:'true'},{key:'xxl.job.executor.appname',value:'task-uat'}]);
 assert.equal(r.unresolved,false);assert.doesNotMatch(JSON.stringify(r),/NEVER_EXPOSE|accessToken|password|logpath/);
});
test('scheduler properties preserves multiple targets and flags unsafe or missing references',()=>{
 const r=schedulerConfiguration('xxl.job.admin.addresses=https://one.example/admin,https://two.example/admin');assert.equal(r.websites.length,2);
 for(const address of ['http://user:secret@jobs.example/admin','http://jobs.example/?token=secret','http://jobs.example/#secret','${missing}','${xxl.job.accessToken}','http://127.0.0.1/admin','${a}']){
 const x=schedulerConfiguration('xxl.job.admin.addresses='+address+'\nxxl.job.accessToken=https://secret.example\na=${b}\nb=${a}');assert.deepEqual(x.websites,[]);assert.equal(x.unresolved,true);assert.doesNotMatch(JSON.stringify(x),/secret/);
 }
 assert.deepEqual(schedulerConfiguration('other.url: https://wrong.example'),{entries:[],websites:[],unresolved:false});
 assert.throws(()=>schedulerConfiguration('x: &x [1]\ny: *x'));
});
test('Nacos discovery continues through runtime tool and preserves attributed entry across source handoff',async()=>{
 const q={mode:'investigate',reviewed:true,description:'调度只读排查',namespaces:['uat'],maxRows:5,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]};
 const env={kind:'nacos',projectId:'demo',tier:'uat',baseUrl:'https://config.example/nacos',credentialRef:'fake',membersRead:true,ownerOpenIdsByProfile:{owner:['admin']},queries:{investigate:q}};
 const cfg={version:1,environments:{env}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对报表定时任务']},'demo',{profile:'owner',senderId:'member'});
 const calls=[];let n=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({username:'synthetic',password:'synthetic'}),tools:async(e,q,c)=>createEnvironmentTools(e,q,c,{fetch:async url=>{
 const u=new URL(url);calls.push(u.pathname);
 if(u.pathname.endsWith('/auth/login'))return JSON.stringify({accessToken:'test-token'});
 if(u.pathname.endsWith('/history/configs'))return JSON.stringify({code:0,data:[{dataId:'config.yaml',group:'task'}]});
 assert.equal(u.searchParams.get('tenant'),'uat');assert.equal(u.searchParams.get('group'),'task');return source;
 }}),planner:async()=>({next:async input=>{
 if(++n===1)return{tool:'discover',arguments:'{}'};
 if(n===2)return{tool:'read_runtime_config',arguments:'{"ref":"config-1"}'};
 assert.equal(input.results.at(-1).result.runtimeDiscovery.websites.length,1);
 return{tool:'finish',summary:'已找到入口，继续网页核验',complete:true};
 },close:async()=>{}})});
 assert.equal(r.partial,true);assert.equal(calls.length,3);assert.equal(r.runtimeDiscoveries[0].source.group,'task');assert.match(r.runtimeDiscoveries[0].source.contentHash,/^[a-f0-9]{64}$/);
 const h=handoffContext({stage:'developer',context:[{result:{...r,finalMessage:'long'.repeat(3000)}}]});
 assert.equal(h[0].runtimeDiscoveries[0].websites[0].url,'http://jobs.example:8080/xxl-job-admin');assert.doesNotMatch(JSON.stringify(r),/NEVER_EXPOSE/);
});
test('runtime config cannot bypass discovered-reference scope or return absent settings as enabled',async()=>{
 const t=await createEnvironmentTools({kind:'nacos',baseUrl:'https://config.example/nacos'},{namespaces:['uat'],timeoutMs:1000,maxRows:5},{},{fetch:async u=>u.pathname.endsWith('/auth/login')?'{"accessToken":"test"}':u.pathname.endsWith('/history/configs')?'{"code":0,"data":[{"dataId":"config.yaml","group":"task"}]}':'unrelated: value'});
 try{await t.run('connection');await assert.rejects(t.run('read_runtime_config',{ref:'foreign'}));await t.run('discover');const r=await t.run('read_runtime_config',{ref:'config-1'});assert.deepEqual(r.runtimeDiscovery.websites,[]);assert.equal(r.partial,true);assert.match(r.stage,/不能据此断言未启用/);}finally{await t.close();}
});
