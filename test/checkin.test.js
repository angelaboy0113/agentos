import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await wait(10);
  }
  assert.fail('Timed out waiting for asynchronous check-in');
}
import {JsonStore} from '../src/shared/store.js';
import {adminUsage} from '../src/control-plane/admin-usage.js';
import {CheckinQueue, handleCheckinAction, publishCheckinCard} from '../src/control-plane/checkin.js';

test('check-in binds original card, separates preview, deduplicates callbacks and rolls over at Beijing midnight', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-checkin-'));
  const store = new JsonStore(path.join(dir, 'agentos.json')), sent = [];
  const profile = 'demo';
  const projects = {humanIdentities:{groupOwner:{demo:'ou_owner'}},chatProjectMap:{oc_group:'test'}};
  const context = {store,projects,agents:{agents:{demo:{profile,systemAssistant:true}}},feishu:{
    async sendCheckinMessage(options) {
      sent.push(options);
      return {data:{message_id:'om_'+sent.length,chat_id:options.receiveIdType==='chat_id'?'oc_group':'oc_dm'}};
    },
  }};
  context.checkinQueue = new CheckinQueue(context);
  context.checkinQueue.start();
  t.after(async () => {
    await context.checkinQueue.close();
    await rm(dir, {recursive:true, force:true});
  });
  const preview = await publishCheckinCard(context, {profile});
  assert.equal(sent[0].receiveIdType,'open_id');
  const buttons = sent[0].content.elements.find((element) => element.tag === 'action').actions;
  assert.deepEqual(buttons.map((button) => [button.text.content, button.type]), [
    ['今日签到', 'primary'], ['查我的积分', 'default'], ['积分商城', 'danger'],
  ]);
  const fresh = await publishCheckinCard(context, {profile,previewRequestId:'private-second'});
  assert.notEqual(fresh.messageId,preview.messageId);
  assert.equal(fresh.chatId,preview.chatId);
  assert.equal((await publishCheckinCard(context,{profile,previewRequestId:'private-second'})).messageId,fresh.messageId);
  await assert.rejects(publishCheckinCard(context,{profile,group:'oc_group',previewRequestId:'private-second'}),{statusCode:400});
  const official = await publishCheckinCard(context, {profile,group:'oc_group'});
  assert.equal((await publishCheckinCard(context, {profile,group:'oc_group'})).messageId,official.messageId);
  const click = (target, user, id, time, action='daily_checkin') => handleCheckinAction(context, {
    agent_profile:profile, operator_id:user, event_id:id, message_id:target.messageId, chat_id:target.chatId,
  }, action, Date.parse(time));
  const before='2026-11-23T15:59:59Z', after='2026-11-23T16:00:00Z';
  assert.equal((await click(preview,'ou_other','a',before)).ignored,true);
  await click(preview,'ou_owner','b',before);
  await click(fresh,'ou_owner','b2',before);
  await click(preview, 'ou_owner', 'mall', before, 'points_store');
  await until(() => sent.some(m => m.content.text === '积分商城，敬请期待。'));
  assert.equal(Object.keys((await store.read()).previewCheckins).length, 1);
  assert.equal(adminUsage(await store.read()).summary.points,0);
  assert.equal((await click(official,'ou_owner','outside',before)).ok,true);
  await Promise.all([click(official,'ou_member','c',before),click(official,'ou_member','d',before)]);
  assert.equal((await click(official,'ou_member','c',before)).duplicate,true);
  await click(official,'ou_member','e',after);
  await click(official,'ou_member','f',after,'my_checkin_points');
  await until(() => sent.some(m => m.receiveId === 'ou_member' && /今天已签到。\n本周 2 积分 · 签到 2 · 提问 0/.test(m.content.text)));
  const state=await store.read();
  assert.equal(Object.values(state.checkins).filter(x=>x.senderId==='ou_member').length,2);
  const usage = adminUsage(state,{chatId:'oc_group'});
  assert.equal(usage.summary.points,3);
  assert.equal(usage.summary.messages,0);
  assert.ok(usage.records.every(x=>x.kind==='checkin'));
});

test('accepts ahead of settlement and private delivery, recovers across restart, and keeps the click day', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-checkin-async-'));
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const sent = [];
  const profile = 'demo';
  const context = {
    store: new JsonStore(path.join(dir, 'agentos.json')),
    projects: {humanIdentities:{groupOwner:{demo:'ou_owner'}},chatProjectMap:{oc_group:'demo'}},
    agents: {agents:{demo:{profile,systemAssistant:true}}},
    feishu: {async sendCheckinMessage(options) {
      sent.push(options);
      if (options.receiveId === 'ou_first') await blocked;
      return {data:{message_id:'om_'+sent.length,chat_id:options.receiveIdType==='chat_id'?'oc_group':'oc_dm'}};
    }},
  };
  context.checkinQueue = new CheckinQueue(context);
  t.after(async () => {
    finish();
    await context.checkinQueue.close();
    await rm(dir, {recursive:true, force:true});
  });
  const group = await publishCheckinCard(context, {profile,group:'oc_group'});
  const clicked = Date.parse('2026-11-23T15:59:59Z'), received = clicked + 2000;
  const event = {agent_profile:profile,operator_id:'ou_first',event_id:'first',message_id:group.messageId,
    chat_id:group.chatId,timestamp:String(clicked)};
  context.checkinQueue.wake = () => {}; // Stop the worker before it sees the durable callback.
  const ack = await handleCheckinAction(context,event,'daily_checkin',received);
  assert.match(ack.message,/已收到/);
  assert.equal(sent.length,1);
  assert.equal(Object.keys((await context.store.read()).checkins ?? {}).length,0);
  await context.checkinQueue.close();
  context.store = new JsonStore(path.join(dir, 'agentos.json'));
  context.checkinQueue = new CheckinQueue(context);
  context.checkinQueue.start();
  await until(() => sent.some(m => m.receiveId==='ou_first'));
  const duplicate = await handleCheckinAction(context,event,'daily_checkin',received);
  assert.equal(duplicate.duplicate,true);
  const other = {...event,event_id:'second',operator_id:'ou_second'};
  assert.equal((await handleCheckinAction(context,other,'daily_checkin',received)).ok,true);
  await until(() => sent.some(m => m.receiveId==='ou_second'));
  const state = await context.store.read();
  assert.equal(Object.values(state.checkins).length,2);
  assert.equal(Object.values(state.checkins).find(row=>row.senderId==='ou_first').day,'2026-11-23');
  assert.equal(sent.filter(m=>m.receiveId==='ou_first').length,1);
  assert.ok(Object.values(state.checkinReceipts).some(r=>r.senderId==='ou_first'&&!r.sent));
  finish();
  await until(async () => Object.values((await context.store.read()).checkinReceipts).every(r=>r.sent));
});
