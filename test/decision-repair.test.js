import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionTurn, conversationFailure, DecisionProtocolError } from '../src/control-plane/codex-conversation.js';
const good={reply:'调查',action:'create_task',intent:'analysis',instruction:'只读查 PRD 源码',jobId:'',projectId:'demo',attachmentIds:[],requiresSourceInspection:true,environmentQuery:null,sourceEnvironment:'prd'};
test('conflicting source/environment decision is repaired once before dispatch',async()=>{
 let calls=0;
 const r=await decisionTurn({turn:async p=>{calls++;if(calls===2){assert.equal(p.threadId,'same');assert.match(p.input[0].text,/不能同时/);}return{text:JSON.stringify(calls===1?{...good,environmentQuery:{environmentId:'prd'}}:good),timing:{}};}},{threadId:'same',outputSchema:{}},{});
 assert.equal(calls,2);assert.equal(r.timing.decisionRepairs,1);assert.equal(JSON.parse(r.text).environmentQuery,null);
});
test('repeated protocol failure stops; transport failure is not blindly retried',async()=>{
 let calls=0;await assert.rejects(decisionTurn({turn:async()=>{calls++;return{text:'invalid JSON'};}},{},{}),DecisionProtocolError);assert.equal(calls,2);
 assert.doesNotMatch(conversationFailure(new DecisionProtocolError('bad')),/检查.*VPN/);
 calls=0;await assert.rejects(decisionTurn({turn:async()=>{calls++;throw new Error('network unavailable');}},{},{}));assert.equal(calls,1);
});
