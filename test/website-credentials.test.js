import test from 'node:test';
import assert from 'node:assert/strict';
import { WebsiteCredentialService, parseWebsiteCredentialMessage } from '../src/control-plane/website-credentials.js';

const environment = { kind:'website', projectId:'demo', tier:'prd', baseUrl:'https://business.example/app/', credentialRef:'web-entry-test',
  ownerOpenIdsByProfile:{owner:['ou_admin']}, membersRead:false, queries:{investigate:{mode:'investigate'}} };
const job = { id:'job-one', status:'awaiting_clarification', originProfile:'owner', result:{browserLoginRequired:true},
  environmentAccess:{kind:'website',environmentId:'site'} };

test('private website credentials are parsed, saved to Keychain adapter and submitted without echoing secrets', async()=>{
  const saved=[],submitted=[],replies=[];
  const context={store:{read:async()=>({jobs:[job]})},feishu:{reply:async(id,text,options)=>replies.push({id,text,options})},
    websiteBrowser:{submitCredentials:async(j,e,cred,options)=>{submitted.push({j,e,cred,options});return {authenticated:true};}}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async(ref,value)=>saved.push({ref,value})});
  const result=await service.handle({message_id:'m1',chat_type:'p2p',agent_profile:'owner',sender_id:'ou_admin',
    content:'网站登录 网址：https://business.example/app/login 账号：alice 密码：S3cret!'});
  assert.equal(result.credentialMessage,true);assert.deepEqual(saved,[{ref:'web-entry-test',value:{username:'alice',password:'S3cret!'}}]);
  assert.equal(submitted.length,1);assert.equal(submitted[0].options.force,true);assert.match(replies[0].text,/登录成功/);
  assert.doesNotMatch(JSON.stringify(replies),/alice|S3cret/);
});

test('credential-looking group messages are swallowed and directed to private chat',async()=>{
  let reads=0;const replies=[];const service=new WebsiteCredentialService({store:{read:async()=>{reads++;return {jobs:[]};}},
    feishu:{reply:async(id,text)=>replies.push(text)},websiteBrowser:{}},{load:async()=>({environments:{}})});
  const result=await service.handle({message_id:'m2',chat_type:'group',agent_profile:'owner',sender_id:'ou_admin',content:'网站登录 账号：alice 密码：group-secret'});
  assert.equal(result.credentialMessage,true);assert.equal(reads,0);assert.match(replies[0],/撤回.*私聊/);assert.doesNotMatch(replies[0],/alice|group-secret/);
});

test('private credential intake requires the configured website owner and supports one pending site without URL',async()=>{
  const replies=[];let saves=0;const context={store:{read:async()=>({jobs:[job]})},feishu:{reply:async(id,text)=>replies.push(text)},websiteBrowser:{submitCredentials:async()=>({authenticated:false})}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async()=>{saves++;}});
  await service.handle({message_id:'m3',chat_type:'p2p',agent_profile:'owner',sender_id:'ou_other',content:'网站登录 账号 alice 密码 secret'});
  assert.equal(saves,0);assert.match(replies.pop(),/没有找到/);
  await service.handle({message_id:'m4',chat_type:'p2p',agent_profile:'owner',sender_id:'ou_admin',content:'网站登录 账号 alice 密码 secret'});
  assert.equal(saves,1);assert.match(replies.pop(),/验证码|登录结果/);
});

test('multiple waiting jobs for the same registered site need only one credential submission',async()=>{
  let saves=0,submits=0;const replies=[];const sameSiteJob={...job,id:'job-two'};
  const context={store:{read:async()=>({jobs:[job,sameSiteJob]})},feishu:{reply:async(id,text)=>replies.push(text)},websiteBrowser:{submitCredentials:async()=>{submits++;return {authenticated:true};}}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async()=>{saves++;}});
  await service.handle({message_id:'m5',chat_type:'p2p',agent_profile:'owner',sender_id:'ou_admin',content:'账号 alice 密码 secret'});
  assert.equal(saves,1);assert.equal(submits,1);assert.match(replies[0],/登录成功/);
});

test('saved website credentials can be retried once by the login poller service',async()=>{
  const calls=[];const service=new WebsiteCredentialService({websiteBrowser:{submitCredentials:async(...args)=>{calls.push(args);return {authenticated:true};}}},
    {read:async()=>({username:'saved-user',password:'saved-password'})});
  assert.equal(await service.autoLogin(job,environment),true);assert.equal(calls.length,1);assert.equal(calls[0][2].username,'saved-user');
});

test('credential command parser requires both account and password',()=>{
  assert.deepEqual(parseWebsiteCredentialMessage('普通问题'),null);
  assert.equal(parseWebsiteCredentialMessage('网站登录 账号：alice').invalid,true);
  assert.deepEqual(parseWebsiteCredentialMessage('网页登录 账号=alice 密码=pwd'),{intent:true,username:'alice',password:'pwd'});
  assert.deepEqual(parseWebsiteCredentialMessage('账号 alice 密码 pwd'),{intent:true,username:'alice',password:'pwd'});
});
