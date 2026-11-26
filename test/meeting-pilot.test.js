import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MeetingPilot } from '../src/control-plane/meeting-pilot.js';
import { createMeetingTransport, meetingError } from '../src/control-plane/meeting-transport.js';
import { handleLarkCliEvent } from '../src/control-plane/server.js';

const settings = {profile:'pilot', projectId:'tpm', chatId:'oc_pilot', documentOrigin:'https://test.feishu.cn'};
const agent = {profile:'pilot', systemAssistant:true, appId:'cli_bot', openId:'ou_bot'};
const meetingId = '1234567890123';
const number = '123456789';
const sender = 'ou_newmember';
const event = {type:'im.message.receive_v1', agent_profile:'pilot', agent_role:'developer', chat_id:'oc_pilot',
  chat_type:'group', sender_type:'user', sender_id:sender, message_id:'om_original', mentions:[{id:agent.openId}]};
const baseTime = Date.parse('2026-11-26T08:00:00Z');
const inMeeting = {id:meetingId, meeting_no:number, status:2, start_time:String(baseTime/1000),
  participants:[{id:sender, user_type:1, status:2, is_external:false}]};
const empty = () => ({conclusions:[], decisions:[], actions:[], unresolved:[], shareableRequirements:[]});
const output = {
  ...empty(),
  conclusions:[{text:'仅私聊的金额结论', sentenceIds:['abc'], owner:'', due:''}],
  decisions:[{text:'按售达方判断分流', sentenceIds:['abc'], owner:'', due:''}],
  actions:[{text:'回查接口状态', sentenceIds:['tail'], owner:'', due:''}],
  unresolved:[{text:'伪造编号不能写入纪要', sentenceIds:['fake'], owner:'', due:''}],
  shareableRequirements:[{text:'按售达方判断分流', sentenceIds:['abc'], owner:'', due:''}],
};
const step = async pilot => {
  await pilot.tick();
  await Promise.all(pilot.inFlight.values());
};
const speech = (id,text,time) => ({event_time:new Date(time).toISOString(),
  payload:{transcript_received_items:[{sentence_id:id, start_time_ms:new Date(time).toISOString(), text, speaker:{user_name:'甲'}}]}});

async function fixture(t, transport, model = {summarizeMeeting:async () => output}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'agentos-meeting-test-'));
  t.after(() => rm(dataDir,{recursive:true,force:true}));
  const context = {config:{dataDir,feishu:{}},projects:{chatProfileProjectMap:{oc_pilot:{pilot:'tpm'}}},agents:{agents:{pilot:agent}}};
  let now = baseTime;
  const clock = value => { now = value; };
  const make = () => new MeetingPilot(context,settings,{transport,model,now:() => now});
  const pilot = make();
  await pilot.ready;
  t.after(() => pilot.close());
  return {pilot,make,context,clock};
}

test('a new member joins once, resumes recorded pages on restart and publishes only the reviewed requirements', async t => {
  let joins = 0;
  const replies = [];
  const messages = [];
  const documents = [];
  const windows = [];
  let pages = 0;
  const transport = {
    lookup:async () => inMeeting, details:async () => inMeeting, join:async () => { joins++; },
    reply:async (...args) => replies.push(args),
    events:async (item,window) => {
      assert.equal(item.meetingId,meetingId);
      windows.push(structuredClone(window));
      pages++;
      if (pages === 1) return {meeting:{id:meetingId,status:'ongoing'},has_more:true,page_token:'p2',events:[speech('abc','未修正',baseTime+1000)]};
      if (pages === 2) return {meeting:{id:meetingId,status:'ended',end_time:new Date(baseTime+2000).toISOString()},
        has_more:false, events:[speech('abc','最终口径',baseTime+1500)]};
      return {meeting:{id:meetingId,status:'ongoing'},has_more:false,
        events:[speech('abc','未修正',baseTime+1000),speech('tail','补充最后一句',baseTime+2200)]};
    },
    direct:async (item,text,key) => messages.push({senderId:item.senderId,text,key}),
    document:async (item,title,sections,audience) => {
      documents.push({title,sections,audience});
      return settings.documentOrigin+'/docx/'+audience.type;
    },
  };
  const {pilot,make,clock,context} = await fixture(t,transport,{
    summarizeMeeting:async ({transcript}) => {
      assert.deepEqual(transcript.map(s => s.text),['最终口径','补充最后一句']);
      return output;
    },
  });
  context.meetings = pilot;
  const input = {...event,content:'记录会议 123 456 789'};
  assert.equal(await pilot.handle({...input,agent_profile:'other'},{agent,content:input.content}),null);
  const receive = () => handleLarkCliEvent(context,input);
  const requests = await Promise.all([receive(),receive()]);
  assert.deepEqual(requests.map(x => x.meetingPilot).sort(),['accepted','duplicate']);
  await Promise.all(pilot.inFlight.values());
  assert.equal(joins,1);
  clock(baseTime+5000);
  await step(pilot);
  const [name] = await readdir(pilot.directory);
  assert.equal((await stat(path.join(pilot.directory,name))).mode & 0o777,0o600);
  assert.equal(JSON.parse(await readFile(path.join(pilot.directory,name))).window.cursor,'p2');
  await pilot.close();
  const recovered = make();
  t.after(() => recovered.close());
  await recovered.ready;
  await step(recovered);
  assert.equal(windows[1].end,windows[0].end);
  assert.equal(windows[1].cursor,'p2');
  clock(baseTime+31_000);
  await step(recovered);
  await step(recovered);
  await step(recovered);
  assert.equal(documents.length,1);
  assert.deepEqual(documents[0].audience,{type:'openid',id:sender,perm:'view'});
  assert.match(JSON.stringify(documents[0]),/负责人 待确认/);
  assert.doesNotMatch(JSON.stringify(documents[0]),/伪造/);
  assert.deepEqual(messages.map(x => x.key),['memo','preview']);
  assert.ok(messages.every(x => x.senderId === sender));
  const [id] = recovered.sessions.keys();
  assert.equal((await recovered.handle({...event,sender_id:'ou_other'},{agent,content:'发布会议初稿 '+id})).meetingPilot,'unavailable');
  assert.equal((await recovered.handle(event,{agent,content:'发布会议初稿 '+id})).meetingPilot,'publishing');
  await step(recovered);
  assert.deepEqual(documents[1].audience,{type:'openchat',id:'oc_pilot',perm:'edit'});
  assert.match(JSON.stringify(documents[1]),/按售达方判断分流/);
  assert.doesNotMatch(JSON.stringify(documents[1]),/仅私聊|回查接口状态/);
  assert.match(messages[2].text,/我要做一个PRD/);
  assert.equal(joins,1);
  assert.ok(!replies.some(args => /仅私聊|售达方|docx/.test(args[1])));
});

test('host AI summary wait survives retries and document failure sends Word privately', async t => {
  let attempts = 0;
  let calls = 0;
  const replies = [];
  const files = [];
  const {pilot,clock} = await fixture(t,{
    lookup:async () => inMeeting, details:async () => inMeeting,
    join:async () => { if (++attempts === 1) throw meetingError('waiting_ai_summary'); },
    reply:async (id,text) => replies.push(text),
    events:async () => ++calls === 1 ? null : {meeting:{id:meetingId,status:'ended',end_time:String((baseTime+62_000)/1000)},
      events:[speech('abc','结束前',baseTime+61_000)],has_more:false},
    document:async () => { throw meetingError('document_acl_unverified'); },
    sendFile:async (session,title) => files.push([session.senderId,title]),
    direct:async () => {},
  }, {summarizeMeeting:async () => ({...empty(),decisions:output.decisions})});
  await pilot.handle(event,{agent,content:'记录会议 https://vc.feishu.cn/j/123456789'});
  await Promise.all(pilot.inFlight.values());
  clock(baseTime+60_000);
  await step(pilot);
  clock(baseTime+63_000);
  await step(pilot);
  clock(baseTime+90_000);
  await step(pilot);
  await step(pilot);
  await step(pilot);
  assert.equal(attempts,2);
  assert.equal(replies.filter(text => text.includes('AI 总结')).length,1);
  assert.deepEqual(files.map(f => f[0]),[sender]);
  assert.equal([...pilot.sessions.values()][0].phase,'complete');
});

test('Feishu adapter checks a current internal participant before join and rejects foreign document access', async () => {
  const requests = [];
  let participant = inMeeting.participants[0];
  let members = [];
  let xml = '';
  const transport = createMeetingTransport({config:{feishu:{}}},settings,async (args, options) => {
    requests.push(args.slice(0,3));
    const [module,action,route] = args;
    if (module === 'api' && route.endsWith('/list_by_no')) return {data:{meeting_briefs:[inMeeting]}};
    if (module === 'api' && route.endsWith('/'+meetingId)) return {data:{meeting:{...inMeeting,participants:[participant]}}};
    if (module === 'api' && action === 'POST') return {data:{document:{document_id:'token'}}};
    if (module === 'api' && route.endsWith('/raw_content')) return {data:{content:xml.replace(/<[^>]+>/g,' ')}};
    if (module === 'drive' && action === '+permission-get-setting') return {data:{permission_public:{link_share_entity:'closed',external_access_entity:'closed'}}};
    if (module === 'drive' && action === '+member-list') return {data:{items:members}};
    if (module === 'drive' && action === '+member-add') {
      members = [{member_id:sender, member_type:'openid', perm:'view'}];
      return {data:{}};
    }
    if (module === 'docs' && action === '+update') {
      assert.equal(args[args.indexOf('--content')+1],'-');
      xml = options.input;
      return {ok:true};
    }
    assert.fail('Unexpected request');
  });
  assert.equal((await transport.lookup(number,sender,baseTime)).id,meetingId);
  participant = {...participant, status:4};
  await assert.rejects(transport.lookup(number,sender,baseTime),{meetingCode:'meeting_requester_unverified'});
  const state = {};
  const session = {appId:agent.appId};
  const sections = [{head:'结论',lines:['结论内容']}];
  const audience = {type:'openid',id:sender,perm:'view'};
  members = [{member_id:'oc_wrong',member_type:'openchat',perm:'view'}];
  await assert.rejects(transport.document(session,'标题',sections,audience,state,async () => {}),{meetingCode:'document_acl_unverified'});
  assert.equal(xml,'');
  members = [];
  assert.equal(await transport.document(session,'标题',sections,audience,state,async () => {}),settings.documentOrigin+'/docx/token');
  assert.equal(requests.filter(r => r[0] === 'api' && r[1] === 'POST').length,1);
});
