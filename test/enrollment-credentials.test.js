import test from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentCredentialService } from '../src/control-plane/enrollment-credentials.js';
function fixture(status='login_required') {
 const e={id:'ENR-test',kind:'nacos',projectId:'tpm',questionId:'q',chatId:'group',profile:'tpm',status,url:'http://prd.test:8848/nacos'};
 const state={environmentEnrollments:{[e.id]:e},questions:{q:{messageId:'root'}}};const saved=[],replies=[];
 const context={projects:{chatProfileProjectMap:{group:{tpm:'tpm',ltx:'ltx'}},projects:{tpm:{},ltx:{}},ownerOpenIdsByProfile:{tpm:['owner']}},
 store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},feishu:{reply:async(id,text)=>replies.push(text)}};
 const service=new EnrollmentCredentialService(context,{save:async(ref,value)=>saved.push({ref,value})});
 const event={message_id:'m',agent_profile:'tpm',sender_id:'owner',chat_id:'group',chat_type:'group',root_id:'root',content:'账号：test-user 密码：test-secret'};
 return {state,saved,replies,service,event,e};
}
test('approved Nacos topic consumes credentials into Keychain without storing or echoing values; duplicate id is ignored',async()=>{
 const f=fixture();assert.equal((await f.service.handle(f.event)).credentialMessage,true);
 assert.deepEqual(f.saved,[{ref:'enr-test',value:{username:'test-user',password:'test-secret'}}]);
 await f.service.handle(f.event);assert.equal(f.saved.length,1);
 assert.doesNotMatch(JSON.stringify([f.state,f.replies]),/test-user|test-secret/);assert.match(f.replies[0],/不代表登录成功/);
});
test('wrong profile, outsider, unbound reply, mismatched URL and mixed endpoints cannot submit to a Nacos target',async()=>{
 for(const change of [{agent_profile:'ltx'},{sender_id:'member'},{chat_id:'other'},{root_id:'unrelated'},{content:'http://other.test/nacos 账号：u 密码：p'},{content:'http://prd.test:8848/nacos http://test.test/nacos 账号：u 密码：p'}]){
  const f=fixture();await f.service.handle({...f.event,...change});assert.equal(f.saved.length,0);
 }
});
test('natural same-value and slash credentials bind to the one related pending target',async()=>{
 for(const content of ['账号密码都是same-secret','账号密码都是：same-secret','same-secret / same-secret']){
  const f=fixture();await f.service.handle({...f.event,content});assert.equal(f.saved.length,1,content);
  assert.deepEqual(f.saved[0].value,{username:'same-secret',password:'same-secret'});
 }
});
test('credentials do not approve a requested target and multiple targets are never guessed',async()=>{
 const f=fixture('requested');await f.service.handle(f.event);assert.equal(f.e.status,'requested');assert.match(f.replies[0],/仍需群主确认/);
 const g=fixture();g.state.environmentEnrollments.second={...g.e,id:'ENR-other',url:'http://other.test/nacos'};
 await g.service.handle(g.event);assert.equal(g.saved.length,0);
});

test('fresh owner credential message retries the same previously approved failed target with a new isolated reference',async()=>{
 const f=fixture('failed');f.e.approver={profile:'tpm',senderId:'owner'};let launched;
 f.service.launch=async(_context,e)=>{launched=e;};
 await f.service.handle(f.event);
 assert.ok(launched);assert.notEqual(launched.id,f.e.id);assert.equal(launched.url,f.e.url);
 assert.equal(launched.retryOf,f.e.id);assert.equal(f.saved[0].ref,launched.id.toLowerCase());
 assert.doesNotMatch(JSON.stringify(f.state),/test-secret|test-user/);
});
