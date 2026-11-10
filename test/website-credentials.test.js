import test from 'node:test';
import assert from 'node:assert/strict';
import { WebsiteCredentialService, parseWebsiteCredentialMessage, stripCredentialMentions,recoverWebsiteToolLogin } from '../src/control-plane/website-credentials.js';

test('expired authentication recovers the original identity then snapshots without replaying an action',async()=>{
 const calls=[];const ctx={websiteCredentials:{recoverLogin:async(j,e)=>{calls.push(['login',j.id,e.credentialRef]);return{authenticated:true,credentialState:'available'};}},websiteBrowser:{run:async(j,e,tool,args)=>{calls.push([tool,j.id,args]);return{pageReady:true};}}};
 const r=await recoverWebsiteToolLogin(ctx,{id:'original'},{credentialRef:'system-prd'},{loginRequired:true});
 assert.equal(r.loginRecovered,true);assert.equal(r.previousOperationReplayed,false);assert.deepEqual(calls,[['login','original','system-prd'],['browser_snapshot','original',{}]]);
});
test('verification or missing credentials preserves waiting; ready pages never trigger login',async()=>{
 let n=0;const ctx={websiteCredentials:{recoverLogin:async()=>{n++;return{authenticated:false,credentialState:'available',loginState:'verification_required'};}},websiteBrowser:{run:()=>{throw Error('must not replay');}}};
 const wait=await recoverWebsiteToolLogin(ctx,{}, {},{loginRequired:true});assert.equal(wait.loginRequired,true);assert.equal(wait.loginRecovery.loginState,'verification_required');
 const ready={pageReady:true};assert.equal(await recoverWebsiteToolLogin(ctx,{}, {},ready),ready);assert.equal(n,1);
});

const environment = { kind:'website', projectId:'demo', tier:'prd', baseUrl:'https://business.example/app/', credentialRef:'web-entry-test',
  ownerOpenIdsByProfile:{owner:['ou_admin']}, membersRead:false, queries:{investigate:{mode:'investigate'}} };
const job = { id:'job-one', status:'awaiting_clarification', originProfile:'owner', agentProfile:'developer', chatId:'group', questionId:'q-one', result:{browserLoginRequired:true},
  environmentAccess:{kind:'website',environmentId:'site'} };
const threadedState = (jobs=[job]) => ({jobs,questions:{'q-one':{id:'q-one',messageId:'root-one',threadRootId:'root-one'}},
  cardMessages:{'question:q-one':{messageId:'card-one',destination:{profile:'owner',replyTo:'root-one'}}}});

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

test('group credentials require a reply to the waiting login card',async()=>{
  const replies=[];const service=new WebsiteCredentialService({store:{read:async()=>({jobs:[]})},
    feishu:{reply:async(id,text)=>replies.push(text)},websiteBrowser:{}},{load:async()=>({environments:{}})});
  const result=await service.handle({message_id:'m2',chat_type:'group',agent_profile:'owner',sender_id:'ou_admin',content:'网站登录 账号：alice 密码：group-secret'});
  assert.equal(result.credentialMessage,true);assert.match(replies[0],/直接回复对应/);assert.doesNotMatch(replies[0],/alice|group-secret/);
});

test('a card or topic reply accepts natural account slash password syntax and binds the exact website',async()=>{
  const saved=[],replies=[];const context={store:{read:async()=>threadedState()},feishu:{reply:async(id,text)=>replies.push(text)},
    websiteBrowser:{submitCredentials:async()=>({authenticated:true})}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async(ref,value)=>saved.push({ref,value})});
  await service.handle({message_id:'m-card',chat_type:'group',chat_id:'group',reply_to:'card-one',agent_profile:'owner',sender_id:'ou_admin',content:'admin / 123456'});
  assert.deepEqual(saved,[{ref:'web-entry-test',value:{username:'admin',password:'123456'}}]);assert.match(replies[0],/登录成功/);
  assert.doesNotMatch(JSON.stringify(replies),/123456/);
  saved.length=0;await service.handle({message_id:'m-topic',chat_type:'group',chat_id:'group',root_id:'root-one',agent_profile:'owner',sender_id:'ou_admin',content:'other-user，other-pass'});
  assert.equal(saved[0].value.username,'other-user');assert.equal(saved[0].value.password,'other-pass');
});

test('credential replies remove the addressed bot mention before parsing account and password',async()=>{
  const saved=[],replies=[];const context={store:{read:async()=>threadedState()},feishu:{reply:async(id,text)=>replies.push(text)},
    websiteBrowser:{submitCredentials:async()=>({authenticated:true})}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async(ref,value)=>saved.push({ref,value})});
  await service.handle({message_id:'m-mentioned',chat_type:'group',chat_id:'group',reply_to:'card-one',agent_profile:'owner',sender_id:'ou_admin',
    mentions:[{key:'@_user_1',name:'项目负责人'}],content:'@项目负责人 synthetic-admin / synthetic-password'});
  assert.deepEqual(saved,[{ref:'web-entry-test',value:{username:'synthetic-admin',password:'synthetic-password'}}]);
  assert.doesNotMatch(JSON.stringify(replies),/synthetic-admin|synthetic-password/);
  assert.equal(stripCredentialMentions('@_user_1 synthetic-admin / synthetic-password',[{key:'@_user_1',name:'项目负责人'}]),'synthetic-admin / synthetic-password');
});

test('credential submission reports a rejected password form separately from verification',async()=>{
  const replies=[];const context={store:{read:async()=>threadedState()},feishu:{reply:async(id,text)=>replies.push(text)},
    websiteBrowser:{submitCredentials:async()=>({authenticated:false,credentialRejected:true})}};
  const service=new WebsiteCredentialService(context,{load:async()=>({environments:{site:environment}}),save:async()=>{}});
  await service.handle({message_id:'m-rejected',chat_type:'group',chat_id:'group',reply_to:'card-one',agent_profile:'owner',sender_id:'ou_admin',content:'synthetic-admin / synthetic-password'});
  assert.match(replies[0],/账号或密码未通过/);assert.doesNotMatch(replies[0],/验证码|synthetic-admin|synthetic-password/);
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
  assert.deepEqual(parseWebsiteCredentialMessage('admin / 123456'),null);
  assert.deepEqual(parseWebsiteCredentialMessage('admin / 123456',{allowLoose:true}),{intent:true,username:'admin',password:'123456'});
  assert.equal(parseWebsiteCredentialMessage('登录 好了',{allowLoose:true}),null);
  assert.equal(parseWebsiteCredentialMessage('网站登录 账号：alice').invalid,true);
  assert.deepEqual(parseWebsiteCredentialMessage('网页登录 账号=alice 密码=pwd'),{intent:true,username:'alice',password:'pwd'});
  assert.deepEqual(parseWebsiteCredentialMessage('账号 alice 密码 pwd'),{intent:true,username:'alice',password:'pwd'});
});

test('automatic recovery reads only the current application credential reference and never returns secret values',async()=>{
 const reads=[],submits=[],service=new WebsiteCredentialService({websiteBrowser:{loginStatusFor:async()=>({pageReady:false}),submitCredentials:async(job,e,cred)=>{submits.push([e.projectId,e.tier,e.credentialRef,cred.username]);return {authenticated:true,loginState:'ready',password:cred.password};}}},{read:async ref=>{reads.push(ref);return {username:ref,password:'synthetic-password'};}});
 const first=await service.recoverLogin(job,{...environment,projectId:'one',tier:'prd',credentialRef:'one-prd'}),second=await service.recoverLogin(job,{...environment,projectId:'two',tier:'uat',credentialRef:'two-sit'});assert.deepEqual(reads,['one-prd','two-sit']);assert.equal(submits[0][3],'one-prd');assert.equal(submits[1][3],'two-sit');assert.doesNotMatch(JSON.stringify([first,second]),/synthetic-password|username/);
});

 test('ordinary topic replies never become malformed credentials even while a login waits',async()=>{for(const text of ['你可管理','权限已经开了','https://example.org/wiki/abc','稍等我看看'])assert.equal(parseWebsiteCredentialMessage(text,{allowLoose:true}),null);const replies=[];const service=new WebsiteCredentialService({store:{read:async()=>threadedState()},feishu:{reply:async(...args)=>replies.push(args)},websiteBrowser:{}},{load:async()=>({environments:{site:environment}})});assert.equal(await service.handle({chat_type:'group',chat_id:'group',root_id:'root-one',agent_profile:'owner',sender_id:'ou_admin',content:'你可管理'}),null);assert.equal(replies.length,0);});
 test('shared topic login candidate requires the originating bot and group',async()=>{const replies=[];const service=new WebsiteCredentialService({store:{read:async()=>threadedState()},feishu:{reply:async(...args)=>replies.push(args)},websiteBrowser:{}},{load:async()=>({environments:{site:{...environment,ownerOpenIdsByProfile:{owner:['ou_admin'],other:['ou_admin']}}}})});assert.equal(await service.handle({chat_type:'group',chat_id:'group',root_id:'root-one',agent_profile:'other',sender_id:'ou_admin',content:'you / synthetic-password'}),null);assert.equal(replies.length,0);});
 test('loading and interactive SSO do not read stored passwords or report missing credentials',async()=>{let reads=0,submits=0;for(const state of [{pageReady:false,loginState:'loading'},{pageReady:false,loginRequired:true,credentialFormVisible:false,loginState:'login_required'}]){const service=new WebsiteCredentialService({websiteBrowser:{loginStatusFor:async()=>state,submitCredentials:async()=>{submits++;}}},{read:async()=>{reads++;throw Error('must not read');}});const result=await service.recoverLogin(job,environment);assert.equal(result.authenticated,false);assert.equal(result.loginState,state.loginState==='loading'?'loading':'interactive_login_required');}assert.equal(reads,0);assert.equal(submits,0);});
