import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {adminUsage} from '../src/control-plane/admin-usage.js';
import {handleCheckinAction, publishCheckinCard} from '../src/control-plane/checkin.js';

test('check-in binds original card, separates preview, deduplicates callbacks and rolls over at Beijing midnight', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'os-checkin-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const store = new JsonStore(path.join(dir, 'agentos.json')), sent = [];
  const profile = 'demo';
  const projects = {humanIdentities:{groupOwner:{demo:'ou_owner'}},chatProjectMap:{oc_group:'test'}};
  const context = {store,projects,agents:{agents:{demo:{profile,systemAssistant:true}}},feishu:{
    async sendCheckinMessage(options) {
      sent.push(options);
      return {data:{message_id:'om_'+sent.length,chat_id:options.receiveIdType==='chat_id'?'oc_group':'oc_dm'}};
    },
  }};
  const preview = await publishCheckinCard(context, {profile});
  assert.equal(sent[0].receiveIdType,'open_id');
  const buttons = sent[0].content.elements.find((element) => element.tag === 'action').actions;
  assert.deepEqual(buttons.map((button) => [button.text.content, button.type]), [
    ['今日签到', 'primary'], ['查我的积分', 'default'], ['积分商城', 'danger'],
  ]);
  const official = await publishCheckinCard(context, {profile,group:'oc_group'});
  assert.equal((await publishCheckinCard(context, {profile,group:'oc_group'})).messageId,official.messageId);
  const click = (target, user, id, time, action='daily_checkin') => handleCheckinAction(context, {
    agent_profile:profile, operator_id:user, event_id:id, message_id:target.messageId, chat_id:target.chatId,
  }, action, Date.parse(time));
  const before='2026-11-23T15:59:59Z', after='2026-11-23T16:00:00Z';
  assert.equal((await click(preview,'ou_other','a',before)).ignored,true);
  await click(preview,'ou_owner','b',before);
  await click(preview, 'ou_owner', 'mall', before, 'points_store');
  assert.equal(sent.at(-1).content.text, '积分商城，敬请期待。');
  assert.equal(Object.keys((await store.read()).previewCheckins).length, 1);
  assert.equal(adminUsage(await store.read()).summary.points,0);
  assert.equal((await click(official,'ou_owner','outside',before)).ok,true);
  await Promise.all([click(official,'ou_member','c',before),click(official,'ou_member','d',before)]);
  assert.equal((await click(official,'ou_member','c',before)).duplicate,true);
  await click(official,'ou_member','e',after);
  await click(official,'ou_member','f',after,'my_checkin_points');
  assert.match(sent.at(-1).content.text,/本周 2 积分 · 签到 2 · 提问 0/);
  const state=await store.read();
  assert.equal(Object.values(state.checkins).filter(x=>x.senderId==='ou_member').length,2);
  const usage = adminUsage(state,{chatId:'oc_group'});
  assert.equal(usage.summary.points,3);
  assert.equal(usage.summary.messages,0);
  assert.ok(usage.records.every(x=>x.kind==='checkin'));
});
