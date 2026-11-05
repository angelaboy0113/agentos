import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTerminalMention, jobTerminalMention, requesterMentionText } from '../src/control-plane/requester-mention.js';

test('native mentions accept only Feishu open IDs and group origins', () => {
  assert.equal(requesterMentionText('ou_abc123', '完成'), '<at user_id="ou_abc123"></at> 完成');
  assert.equal(requesterMentionText('all', '完成'), null);
  assert.equal(requesterMentionText('ou_bad\"></at><at user_id="all', '完成'), null);
  assert.equal(conversationTerminalMention({ chatType: 'p2p', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), null);
  assert.deepEqual(conversationTerminalMention({ chatType: 'group', messageId: 'm', profile: 'owner', senderId: 'ou_abc123' }), {
    replyTo: 'm', profile: 'owner', text: '<at user_id="ou_abc123"></at> 本次回复已完成，请查看上方结果。',
  });
});

test('task mentions only final mission outcomes and retains the originating bot identity', () => {
  const job = { originChatType: 'group', originMessageId: 'm-origin', replyToMessageId: 'm-latest',
    originProfile: 'owner', senderId: 'ou_abc123', status: 'completed' };
  assert.equal(jobTerminalMention({ ...job, status: 'awaiting_approval' }), null);
  assert.equal(jobTerminalMention({ ...job, nextJobId: 'JOB-next' }), null);
  assert.deepEqual(jobTerminalMention(job), {
    replyTo: 'm-origin', profile: 'owner', text: '<at user_id="ou_abc123"></at> 任务已结束，请查看上方结果。',
  });
});

test('source sync blocks mention origin-profile admins with deduplication and legacy fallback', () => {
  const job = { taskIntent: 'analysis', status: 'blocked', originChatType: 'group', originMessageId: 'm',
    originProfile: 'owner', agentProfile: 'dev', senderId: 'ou_member', result: { sourceSyncBlocked: true } };
  const config = { ownerOpenIdsByProfile: { owner: ['ou_admin', 'ou_admin', 'all'], dev: ['ou_wrongApp'] }, ownerOpenIds: ['ou_legacy'] };
  const text = jobTerminalMention(job, config).text;
  assert.equal((text.match(/<at /g) ?? []).length, 2);
  assert.match(text, /ou_member/); assert.match(text, /ou_admin/);
  assert.doesNotMatch(text, /ou_wrongApp|ou_legacy|user_id="all"/);
  assert.equal((jobTerminalMention({ ...job, senderId: 'ou_admin' }, config).text.match(/<at /g) ?? []).length, 1);
  assert.doesNotMatch(jobTerminalMention(job, { ...config, ownerOpenIdsByProfile: { owner: [] } }).text, /ou_legacy/);
  assert.match(jobTerminalMention(job, { ownerOpenIds: ['ou_legacy'] }).text, /ou_legacy/);
  assert.equal(jobTerminalMention({ ...job, originChatType: 'p2p' }, config), null);
  for (const result of [{}, { finalMessage: '源码同步受阻' }]) {
    assert.doesNotMatch(jobTerminalMention({ ...job, result }, config).text, /ou_admin/);
  }
});

test('successful task actions defer chat mentions to final task outcome, while rejected actions still reply', () => {
  const turn = { chatType: 'group', messageId: 'm', profile: 'owner', senderId: 'ou_requester' };
  for (const action of ['create_task', 'approve', 'clarify', 'cancel']) {
    assert.equal(conversationTerminalMention({ ...turn, decision: { action }, outcome: { jobId: 'J' } }), null);
    assert.ok(conversationTerminalMention({ ...turn, decision: { action }, actionError: 'rejected' }));
  }
  assert.ok(conversationTerminalMention({ ...turn, outcome: {} }));
  assert.equal(jobTerminalMention({ originChatType: 'group', status: 'completed', nextJobId: 'report' }), null);
});

test('partial results and failed tasks notify requester without implying investigation completed',()=>{
 const job={status:'completed',originChatType:'group',originMessageId:'origin',originProfile:'owner',senderId:'ou_abc123',result:{outcome:'partial'}};
 assert.match(jobTerminalMention(job).text,/排查尚未完成/);
 assert.doesNotMatch(jobTerminalMention(job).text,/任务已结束/);
 assert.match(jobTerminalMention({...job,status:'failed',result:{}}).text,/排查受阻/);
});

test('browser automation wait asks for macOS permission instead of another website login', () => {
  const mention = jobTerminalMention({ originChatType:'group', status:'awaiting_clarification',
    result:{browserLoginRequired:true,browserActionRequired:'automation'}, environmentAccess:{approvalOwnerIds:['ou_admin']},
    originMessageId:'m', originProfile:'owner' });
  assert.match(mention.text,/放行系统对Chrome的自动化访问/);
  assert.doesNotMatch(mention.text,/网页登录/);
});

test('automatic website recovery does not mention administrators, including its initial unknown state', () => {
 const base={originChatType:'group',status:'awaiting_clarification',environmentAccess:{approvalOwnerIds:['ou_admin']},originMessageId:'m',originProfile:'owner'};
 for(const state of [undefined,'login_required','loading','waiting'])for(const credentials of [undefined,'unknown','available'])assert.equal(jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state,browserCredentialState:credentials,loginUrl:'https://jobs.example/xxl-job-admin/'}}),null);
 assert.ok(jobTerminalMention({...base,result:{browserLoginRequired:true,browserCredentialState:'unavailable'}}));
 for(const state of ['credential_unavailable','password_change_required','service_error','request_error','rate_limited'])assert.ok(jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state}}));
});

test('intake failures never announce a completed reply',()=>{
 const turn={chatType:'group',messageId:'m',profile:'owner',senderId:'ou_requester'};
 for(const extra of [{aiFailed:true},{actionError:'rejected'}]){const text=conversationTerminalMention({...turn,...extra}).text;assert.doesNotMatch(text,/回复已完成/);assert.match(text,/失败|未执行/);}
});

test('login-chain failure, rejection and verification notices do not ask users to resend saved credentials',()=>{
 const base={originChatType:'group',status:'awaiting_clarification',environmentAccess:{approvalOwnerIds:['ou_admin']},originMessageId:'m',originProfile:'owner'};
 for(const state of ['request_blocked','access_check_failed','rejected','verification_required']){const text=jobTerminalMention({...base,result:{browserLoginRequired:true,browserLoginState:state,browserCredentialState:'available'}}).text;assert.doesNotMatch(text,/直接回复.*密码/);assert.match(text,/无需重发|无需重发|安全更新|本机页面/);}
});


test('red terminal alerts use the configured human in the same bot identity and do not notify private or historical tasks',async()=>{
 const {failureNotice,validateFailureNotice}=await import('../src/control-plane/requester-mention.js');
 const projects={humanIdentities:{maintainer:{a:'ou_adminA',b:'ou_adminB'}},failureNotice:{enabled:true,humanId:'maintainer',message:'哎呀，怎么受阻了，老大快来看看 👀',since:'2026-11-05T00:00:00Z'}};
 const base={replyTo:'origin',profile:'a',text:'<at user_id="ou_requester"></at> 排查受阻，请查看原因。'};
 const view={card:{header:{template:'red'}},terminal:true,profile:'a',chatType:'group',occurredAt:'2026-11-05T01:00:00Z'};
 assert.match(failureNotice(base,view,projects).text,/ou_adminA/);assert.doesNotMatch(failureNotice(base,view,projects).text,/ou_adminB/);
 assert.match(failureNotice({...base,profile:'b'},{...view,profile:'b'},projects).text,/ou_adminB/);
 for(const extra of [{terminal:false},{visibility:'requester'},{chatType:'p2p'},{profile:'unknown'},{occurredAt:'2026-11-04T00:00:00Z'},{occurredAt:undefined},...['green','orange','grey','blue'].map(template=>({card:{header:{template}}}))])assert.deepEqual(failureNotice(base,{...view,...extra},projects),base);
 const already={...base,text:'<at user_id="ou_adminA"></at> 原因已说明。'};assert.equal((failureNotice(already,view,projects).text.match(/<at /g)||[]).length,1);
 assert.deepEqual(failureNotice(base,view,{...projects,failureNotice:{...projects.failureNotice,enabled:false}}),base);
 assert.throws(()=>validateFailureNotice({...projects.failureNotice,message:'<at user_id="all"></at>'},projects.humanIdentities));
});

test('red alert retry freezes the same native idempotency key and repeated card renders do not notify twice',async()=>{
 const {LiveCards}=await import('../src/control-plane/live-cards.js');const {failureNotice}=await import('../src/control-plane/requester-mention.js');
 const state={jobs:[],conversations:[],questions:{q:{id:'q',generation:1}},cardMessages:{}};const store={file:'/tmp/agentos-red-alert-test/state.json',read:async()=>structuredClone(state),transact:async f=>f(state)};
 const attempts=[];let delivered=0;const service=new LiveCards(store,{replyCard:async()=>({message_id:'card'}),updateCard:async()=>{},reply:async(id,text,options)=>{attempts.push({id,text,key:options.idempotencyKey});if(attempts.length===1)throw Error('temporary network');delivered++;}});
 const card={schema:'2.0',header:{template:'red',title:{tag:'plain_text',content:'合成故障'}},body:{elements:[{tag:'markdown',content:'原始错误保留'}]}};
 const mention=failureNotice({replyTo:'origin',profile:'a',text:'<at user_id="ou_requester"></at> 失败原因见卡片。'},{card,terminal:true,profile:'a',chatType:'group',occurredAt:'2026-11-05T01:00:00Z'},{humanIdentities:{owner:{a:'ou_admin'}},failureNotice:{enabled:true,humanId:'owner',message:'老大快来看看 👀',since:'2026-11-05T00:00:00Z'}});
 const render=()=>service.upsert('question:q',card,{replyTo:'origin',profile:'a',replyInThread:true},{terminal:true,immediate:true,generation:1,terminalMention:mention});
 await assert.rejects(render(),/temporary network/);for(let i=0;i<2;i++)await render();
 assert.equal(delivered,1);assert.equal(attempts.length,2);assert.equal(attempts[0].key,attempts[1].key);assert.equal(attempts[1].id,'origin');assert.match(attempts[1].text,/ou_requester.*\n.*ou_admin/);await service.stop();
});

test('failure notice configuration survives real projects-file loading and rejects missing trusted identities',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {loadProjects}=await import('../src/control-plane/config.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'failure-config-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'projects.json');
 const config={projects:{},humanIdentities:{maintainer:{a:'ou_admin'}},failureNotice:{enabled:true,humanId:'maintainer',message:'老大快来看看 👀',since:'2026-11-05T00:00:00Z'}};await writeFile(file,JSON.stringify(config));assert.deepEqual((await loadProjects(file)).failureNotice,config.failureNotice);
 await writeFile(file,JSON.stringify({...config,humanIdentities:{}}));await assert.rejects(loadProjects(file),/Invalid failureNotice/);
});
