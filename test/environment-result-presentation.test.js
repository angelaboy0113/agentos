import test from 'node:test';
import assert from 'node:assert/strict';
import { presentEnvironmentResult } from '../src/runner/environment-result-presentation.js';
import { conciseSummary } from '../src/control-plane/result-presentation.js';
const plan = { tier:'uat', description:'查数据库配置', kind:'nacos' };
const row = {host:'db.example',port:3306,database:'demo',password:'hidden-secret'};
const result = {rows:[row,{...row}],evidence:{readAt:'2026-09-16'},note:'来自Nacos；未连接数据库。'};
test('query answer survives card summary clipping, deduplicates endpoints and hides credential fields',()=>{
 const p=presentEnvironmentResult(plan,result);const visible=conciseSummary(p.summary);
 for(const value of ['db.example','3306','demo','未连接数据库'])assert.ok(visible.includes(value));
 assert.equal((visible.match(/主机\/IP/g)||[]).length,1);assert.doesNotMatch(JSON.stringify(p),/hidden-secret|password/);
 assert.doesNotMatch(p.metadata,/db.example|demo/);
});
test('empty and partial queries do not claim complete; overflow points to full evidence',()=>{
 assert.match(presentEnvironmentResult(plan,{...result,rows:[]}).summary,/未返回记录/);
 const r=presentEnvironmentResult(plan,{...result,partial:true,rows:[row,{...row,host:'two.example'},{...row,host:'three.example'}]});
 assert.match(r.summary,/尚未完成/);assert.match(r.summary,/另有 1 条/);assert.match(r.details,/three.example/);
});

import { jobCard } from '../src/control-plane/message-cards.js';
test('completed query puts answers first while approval still exposes full scope',()=>{
 const presented=presentEnvironmentResult(plan,result);
 const job={id:'job-demo',stage:'developer',status:'completed',taskIntent:'analysis',createdAt:'2026-09-16',updatedAt:'2026-09-16',environmentAccess:{...plan,environmentId:'env',queryId:'investigate',parameters:['purpose'],maxRows:20,timeoutMs:5000,expiresAt:'expiry'},result:{summary:presented.summary,finalMessage:presented.details}};
 const front=JSON.stringify(jobCard(job).body.elements[0]);assert.match(front,/db.example/);assert.doesNotMatch(front,/授权截止|模板：/);
 const approval=JSON.stringify(jobCard({...job,status:'awaiting_environment_approval',result:null}));assert.match(approval,/授权截止/);assert.match(approval,/批准本次只读查询/);
});
