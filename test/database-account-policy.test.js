import test from 'node:test';import assert from 'node:assert/strict';
import {accountMode,CONNECTION_SQL} from '../src/shared/database-account-policy.js';
import {checkAccountGrants,mysqlRead} from '../src/runner/environment-connector.js';
const business=()=>({kind:'mysql',accountPolicy:'business-readonly',ownerOpenIdsByProfile:{owner:['ou_admin']},businessAccountAuthorization:{approverId:'ou_admin',confirmedAt:new Date().toISOString()},queries:{check:{sql:CONNECTION_SQL}}});
const grants=[{grant:'GRANT SELECT, INSERT, UPDATE, DELETE ON demo.* TO user'}];
test('business account requires explicit admin authorization and restricts SQL templates',()=>{
 assert.throws(()=>checkAccountGrants({},grants));assert.doesNotThrow(()=>checkAccountGrants(business(),grants));
 for(const mutate of [e=>delete e.businessAccountAuthorization,e=>e.businessAccountAuthorization.approverId='ou_member',e=>e.queries.check.sql='SELECT dangerous_function()',e=>e.accountPolicy='anything']) {const e=business();mutate(e);assert.throws(()=>accountMode(e));}
 assert.throws(()=>checkAccountGrants(business(),[]));
});
test('business mode still starts readonly transaction before bound query and rolls back',async()=>{
 const calls=[];const connection={query:async sql=>{calls.push(sql);return [grants];},execute:async(q,p)=>{calls.push(q.sql);return [[{database_name:'demo'}]];},rollback:async()=>calls.push('rollback'),destroy:()=>calls.push('destroy')};
 await mysqlRead(business(),{sql:CONNECTION_SQL,parameters:[],outputColumns:['database_name'],timeoutMs:1000,maxRows:1},[],{username:'fake',password:'fake'},{mysql:{createConnection:async options=>{assert.equal(options.multipleStatements,false);return connection;}}});
 assert.ok(calls.indexOf('START TRANSACTION READ ONLY')<calls.findIndex(x=>x.startsWith('SELECT *')));assert.deepEqual(calls.slice(-2),['rollback','destroy']);
});
test('readonly transaction failure stops business account before executing data query',async()=>{
 let executed=false,destroyed=false;
 await assert.rejects(mysqlRead(business(),{sql:CONNECTION_SQL,outputColumns:[],timeoutMs:1000,maxRows:1},[],{}, {mysql:{createConnection:async()=>({query:async sql=>{if(sql==='START TRANSACTION READ ONLY')throw new Error('denied');return [grants];},execute:async()=>{executed=true;return [[]];},rollback:async()=>{},destroy:()=>{destroyed=true;}})}}));assert.equal(executed,false);assert.equal(destroyed,true);
});
