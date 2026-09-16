import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {databaseCredential} from '../src/runner/config-endpoints.js';import {automaticDatabaseEnrollment} from '../src/control-plane/automatic-database-enrollment.js';import {fingerprint} from '../src/shared/environment-access.js';
const content='commons:\n  mysql:\n    host: db.test\n    port: 3306\n    db: demo\n    username: fake-business\n    password: fake-secret\nspring:\n  datasource:\n    url: jdbc:mysql://${commons.mysql.host}:${commons.mysql.port}/${commons.mysql.db}\n    username: ${commons.mysql.username}\n    password: ${commons.mysql.password}\n';
const target={host:'db.test',port:3306,database:'demo'};
test('private extraction resolves same-file datasource secrets and rejects missing or ambiguous credentials',()=>{
 assert.deepEqual(databaseCredential(content,target),{username:'fake-business',password:'fake-secret'});
 for(const s of [content.replace('fake-secret','${EXTERNAL_SECRET}'),content.replace('fake-secret','ENC(encrypted)'),content.replace('password: ${commons.mysql.password}','password: ${missing}')])assert.throws(()=>databaseCredential(s,target));
 assert.throws(()=>databaseCredential(content,{...target,database:'other'}));
 const extra='\nother:\n  url: jdbc:mysql://db.test:3306/demo\n  username: different\n  password: different\n';assert.throws(()=>databaseCredential(content+extra,target));
});
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'auto-db-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'environments.json');
 const e={projectId:'demo',tier:'prd',kind:'nacos',credentialRef:'nacos',baseUrl:'http://nacos.test/nacos',ownerOpenIdsByProfile:{owner:['ou_admin']},membersRead:false,queries:{investigate:{reviewed:true,description:'read',mode:'investigate',namespaces:['prd'],parameters:[{name:'purpose',type:'string'}],maxRows:5,maxCalls:4,timeoutMs:1000}}};
 await writeFile(file,JSON.stringify({version:1,environments:{source:e}}));
 const enrollment={id:'ENR-synthetic',status:'opening',createdAt:new Date().toISOString(),kind:'mysql',tier:'prd',projectId:'demo',url:'mysql://db.test:3306/demo',approver:{profile:'owner',senderId:'ou_admin'},databaseSource:{...target,sourceEnvironmentId:'source',sourceQueryId:'investigate',sourceConfigHash:fingerprint(e),connectionSource:{namespace:'prd',group:'DEFAULT_GROUP',dataId:'db.yaml',contentHash:createHash('sha256').update(content).digest('hex')}}};
 const calls=[];const adapters={file,credential:async()=>({username:'fake-nacos',password:'fake-nacos-secret'}),fetch:async(url)=>{calls.push('fetch');return String(url).includes('auth/login')?JSON.stringify({accessToken:'fake-token'}):content;},mysqlRead:async(e,q,p,c)=>{calls.push('mysql');assert.equal(e.tls,true);assert.equal(e.accountPolicy,'business-readonly');assert.equal(c.password,'fake-secret');},saveCredential:async(id,c)=>{calls.push('save');assert.equal(c.password,'fake-secret');}};
 return {dir,file,enrollment,adapters,calls,context:{config:{dataDir:dir}}};
}
test('approved local automatic enrollment tests connection before saving and never writes secrets to config/status',async t=>{
 const f=await fixture(t);await automaticDatabaseEnrollment(f.context,f.enrollment,f.adapters);
 assert.ok(f.calls.indexOf('mysql')<f.calls.indexOf('save'));
 const raw=await readFile(f.file,'utf8');assert.doesNotMatch(raw,/fake-secret|fake-business|fake-token/);assert.equal(JSON.parse(raw).environments['enr-synthetic'].membersRead,false);
 assert.equal(JSON.parse(await readFile(path.join(f.dir,'environment-enrollments','ENR-synthetic','status.json'),'utf8')).status,'complete');
});
test('automatic enrollment rejects wrong approver, changed source, namespace, target and failed connection without saving',async t=>{
 for(const mutate of [e=>e.approver.senderId='ou_member',e=>e.databaseSource.sourceConfigHash='wrong',e=>e.databaseSource.connectionSource.namespace='uat',e=>e.url='mysql://other:3306/demo',e=>e.databaseSource.connectionSource.contentHash='wrong',e=>e.createdAt='2020-01-01']) {
  const f=await fixture(t);mutate(f.enrollment);const before=await readFile(f.file,'utf8');await assert.rejects(automaticDatabaseEnrollment(f.context,f.enrollment,f.adapters));assert.equal(f.calls.includes('save'),false);assert.equal(await readFile(f.file,'utf8'),before);
 }
 const f=await fixture(t);f.adapters.mysqlRead=async()=>{throw new Error('TLS failed');};await assert.rejects(automaticDatabaseEnrollment(f.context,f.enrollment,f.adapters));assert.equal(f.calls.includes('save'),false);
});
