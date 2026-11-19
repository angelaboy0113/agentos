import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {RemoteLoginQr} from '../src/control-plane/remote-login-qr.js';
import {validateLoginNavigation} from '../src/shared/login-navigation.js';
const waiting={loginRequired:true,verificationRequired:true};
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'private-qr-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const e={projectId:'one',tier:'uat',baseUrl:'https://auth.fixture.test/',loginNavigation:{interactive:true,steps:['微信登录'],remoteQr:true},ownerOpenIdsByProfile:{bot:['ou_admin']}};
 const job={id:'j',projectId:'one',originProfile:'bot',status:'awaiting_clarification',result:{browserLoginRequired:true},environmentAccess:{environmentId:'web',scopeHash:'scope'}};
 const state={jobs:[job]},calls=[];
 const context={config:{dataDir},projects:{humanIdentities:{groupOwner:{bot:'ou_admin',other:'ou_other'}},ownerOpenIdsByProfile:{bot:['ou_admin'],other:['ou_other']}},store:{getJob:async id=>state.jobs.find(j=>j.id===id),read:async()=>structuredClone(state),view:async fn=>structuredClone(fn(state)),transact:async fn=>fn(state)},websiteBrowser:{captureLoginQr:async()=>({buffer:Buffer.from('private challenge'),sha256:'a'.repeat(64)})},feishu:{cardRequest:async(...args)=>{calls.push(args);return {data:{message_id:'notice'}};},replyImage:async(_,file,options)=>{assert.equal((await readFile(file)).toString(),'private challenge');calls.push(['image',options]);return {data:{message_id:'image'}};}}};
 let now=1000000;const service=new RemoteLoginQr(context,{now:()=>now});return {e,job,state,calls,context,service,advance:n=>now+=n};
}
test('remote QR configuration requires explicit interactive opt-in',()=>{assert.throws(()=>validateLoginNavigation({steps:['登录'],remoteQr:true}));assert.throws(()=>validateLoginNavigation({interactive:true,steps:['登录'],remoteQr:false}));assert.ok(validateLoginNavigation({interactive:true,steps:['登录'],remoteQr:true}));});
test('private administrator delivery persists receipt, cleans local QR and deduplicates concurrent observers',async t=>{const f=await fixture(t);await Promise.all([f.service.observe(f.job,f.e,waiting),f.service.observe(f.job,f.e,waiting)]);await f.service.observe(f.job,f.e,waiting);assert.equal(f.calls.filter(c=>c[0]==='image').length,1);assert.deepEqual(f.calls.find(c=>c[0]==='image')[1].privateRecipient,'ou_admin');assert.deepEqual(await readdir(path.join(f.context.config.dataDir,'private-login-qr')),[]);assert.equal(JSON.stringify(f.state).includes('private challenge'),false);});
test('no code is sent on ready page, missing opt-in, missing owner or changed task grant',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,{pageReady:true});await f.service.observe(f.job,{...f.e,loginNavigation:{}},waiting);await f.service.observe({...f.job,originProfile:'unknown'},f.e,waiting);await f.service.observe({...f.job,environmentAccess:{...f.job.environmentAccess,scopeHash:'other'}},f.e,waiting);assert.equal(f.calls.length,0);});
test('cancelled and withdrawn tasks cannot create a QR delivery',async t=>{const f=await fixture(t);f.job.status='cancelled';await f.service.observe(f.job,f.e,waiting);assert.equal(f.calls.length,0);});
test('pending image delivery retries with identical idempotency key after restart',async t=>{const f=await fixture(t),send=f.context.feishu.replyImage,keys=[];f.context.feishu.replyImage=async(a,b,o)=>{keys.push(o.idempotencyKey);throw Error('network');};await f.service.observe(f.job,f.e,waiting);f.advance(31000);f.context.feishu.replyImage=async(a,b,o)=>{keys.push(o.idempotencyKey);return send(a,b,o);};const restarted=new RemoteLoginQr(f.context,{now:()=>1031000});await restarted.observe(f.job,f.e,waiting);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(f.calls.filter(c=>c[0]==='POST').length,1);});
test('successful authentication retires the QR without querying or changing original job',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,waiting);await f.service.observe(f.job,f.e,{pageReady:true,loginRequired:false});assert.equal(f.calls.filter(c=>c[0]==='DELETE').length,1);assert.equal(Object.values(f.state.remoteLoginQr)[0].state,'authenticated');assert.equal(f.job.status,'awaiting_clarification');});
test('expired code retires and waits for refresh instead of repeatedly resending',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,waiting);await f.service.observe(f.job,f.e,{...waiting,verificationExpired:true});f.advance(200000);await f.service.observe(f.job,f.e,waiting);assert.equal(f.calls.filter(c=>c[0]==='image').length,1);assert.equal(Object.values(f.state.remoteLoginQr)[0].state,'expired');});
test('project/environment and robot identities have independent challenge keys',async t=>{const f=await fixture(t);const b=f.service.binding(f.job,f.e);assert.notEqual(b.key,f.service.binding(f.job,{...f.e,tier:'prd'}).key);assert.equal(f.service.binding({...f.job,originProfile:'other'},f.e),null);});
test('non-administrator and group refresh commands are never accepted',async t=>{const f=await fixture(t);assert.equal(await f.service.handle({content:'刷新扫码',chat_type:'group',agent_profile:'bot',sender_id:'ou_admin'}),null);assert.equal(await f.service.handle({content:'刷新扫码',chat_type:'p2p',agent_profile:'bot',sender_id:'ou_other'}),null);});
test('QR deletion failure preserves receipt and retries without preventing login recovery',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,waiting);const request=f.context.feishu.cardRequest;f.context.feishu.cardRequest=async()=>{throw Error('offline');};await f.service.observe(f.job,f.e,{pageReady:true,loginRequired:false});const v=Object.values(f.state.remoteLoginQr)[0];assert.equal(v.retirePending,true);assert.equal(v.messageId,'image');f.context.feishu.cardRequest=request;await f.service.sweep();assert.equal(v.retirePending,false);assert.equal(v.state,'authenticated');});
test('cancelled original task QR is retired and a later task receives a new generation',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,waiting);const first=Object.values(f.state.remoteLoginQr)[0];f.job.status='cancelled';await f.service.sweep();const next={...f.job,id:'next',status:'awaiting_clarification'};f.state.jobs.push(next);await f.service.observe(next,f.e,waiting);const last=Object.values(f.state.remoteLoginQr)[0];assert.equal(last.generation,first.generation+1);assert.equal(last.jobId,'next');assert.equal(f.calls.filter(c=>c[0]==='image').length,2);});
test('private owner refresh serializes the same scoped challenge and issues a new generation',async t=>{const f=await fixture(t);await f.service.observe(f.job,f.e,waiting);await f.service.observe(f.job,f.e,{...waiting,verificationExpired:true});let refreshed=0;f.context.websiteBrowser.refreshLoginQr=async(j,e)=>{assert.equal(j.id,f.job.id);assert.equal(e.tier,'uat');refreshed++;};f.context.websiteBrowser.loginStatusFor=async()=>waiting;const service=new RemoteLoginQr(f.context,{now:()=>1200000,load:async()=>({environments:{web:f.e}})});await service.handle({content:'刷新扫码',chat_type:'p2p',agent_profile:'bot',sender_id:'ou_admin'});assert.equal(refreshed,1);assert.equal(Object.values(f.state.remoteLoginQr)[0].generation,2);assert.equal(f.job.status,'awaiting_clarification');});

test('a previously retired challenge cannot block a later task even if deleting it again would fail',async t=>{
 const f=await fixture(t);
 await f.service.observe(f.job,f.e,waiting);
 await f.service.observe(f.job,f.e,{pageReady:true,loginRequired:false});
 const previous=Object.values(f.state.remoteLoginQr)[0];assert.ok(previous.retiredAt);
 previous.retryAt=2000000;
 const request=f.context.feishu.cardRequest;
 f.context.feishu.cardRequest=async(method,...args)=>{
  if(method==='DELETE')throw Error('Already withdrawn');
  return request(method,...args);
 };
 f.job.status='completed';
 const later={...f.job,id:'later',status:'awaiting_clarification'};
 f.state.jobs.push(later);
 await f.service.observe(later,f.e,waiting);
 const active=Object.values(f.state.remoteLoginQr)[0];
 assert.equal(active.jobId,later.id);assert.equal(active.generation,2);assert.equal(active.state,'sent');
 assert.equal(f.calls.filter(c=>c[0]==='image').length,2);
});
