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
  const projects = {humanIdentities:{groupOwner:{demo:'ou_owner'},member:{demo:'ou_member',other:'ou_linked'}},chatProjectMap:{oc_group:'test'}};
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
  const pointsStorePreviewCard = {schema:'2.0',header:{title:{content:'AgentOS 积分商城'}},body:{elements:[
    {tag:'column_set',columns:[{elements:[{tag:'button',behaviors:[{type:'callback',value:{action:'points_store'}}]}]}]},
  ]}};
  const shopRequest = {profile,previewRequestId:'private-shop-demo',pointsStorePreviewCard};
  const shop = await publishCheckinCard(context,shopRequest);
  assert.deepEqual(sent.at(-1).content,pointsStorePreviewCard);
  assert.equal(sent.at(-1).receiveId,'ou_owner');
  assert.equal((await publishCheckinCard(context,shopRequest)).messageId,shop.messageId);
  await assert.rejects(publishCheckinCard(context,{...shopRequest,group:'oc_group'}),{statusCode:400});
  const changed = structuredClone(pointsStorePreviewCard);
  changed.body.elements.push({tag:'markdown',content:'Changed'});
  await assert.rejects(publishCheckinCard(context,{...shopRequest,pointsStorePreviewCard:changed}),{statusCode:409});
  changed.body.elements[0].columns[0].elements[0].behaviors[0].value.action='daily_checkin';
  await assert.rejects(publishCheckinCard(context,{...shopRequest,pointsStorePreviewCard:changed}),{statusCode:400});
  assert.equal((await click(shop,'ou_owner','shop-invalid',before)).reason,'checkin_card_action_mismatch');
  assert.equal((await click(shop,'ou_other','shop-other',before,'points_store')).ignored,true);
  assert.equal((await click(shop,'ou_owner','shop-trial',before,'points_store')).ok,true);
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
  await until(() => sent.some(m => m.receiveId === 'ou_member' && /今天已签到。\n累计 2 积分 · 签到 2 · 提问 0/.test(m.content.text)));
  const state=await store.read();
  assert.equal(Object.values(state.checkins).filter(x=>x.senderId==='ou_member').length,2);
  const usage = adminUsage(state,{chatId:'oc_group'});
  assert.equal(usage.summary.points,3);
  assert.equal(usage.summary.messages,0);
  assert.ok(usage.records.every(x=>x.kind==='checkin'));
  const memberReceipts = sent.filter(m => m.receiveId === 'ou_member').map(m => m.content.text);
  assert.deepEqual(memberReceipts.slice(0,3), [
    '11月23日获得 1 积分\n累计积分 1',
    '11月23日获得 1 积分\n累计积分 1',
    '11月24日获得 1 积分\n累计积分 2',
  ]);
  assert.ok(sent.some(m => m.receiveId === 'ou_owner' && m.content.text === '【私聊体验】11月23日获得 1 积分\n累计积分 1'));
  await store.transact(s => {
    s.checkins.historic = {id:'historic',profile:'other',senderId:'ou_linked',chatId:'oc_another',day:'2026-10-30',createdAt:'2026-10-30T00:00:00Z',points:1};
    s.checkins.unrelated = {id:'unrelated',profile:'other',senderId:'ou_stranger',chatId:'oc_another',day:'2026-10-30',createdAt:'2026-10-30T00:00:00Z',points:1};
    const turn = {chatId:'oc_another',chatType:'group',createdAt:'2026-10-30T00:00:00Z',content:'要查一份预算',senderName:'同名伙伴',archivedAt:'2026-11-20T00:00:00Z'};
    s.conversations = [
      {...turn,id:'first',messageId:'om_first',profile:'other',senderId:'ou_linked'},
      {...turn,id:'second',messageId:'om_second',profile:'demo',senderId:'ou_member',chatId:'oc_group'},
      {...turn,id:'third',messageId:'om_third',profile:'demo',senderId:'ou_member',visibility:'private'},
      {...turn,id:'unrelated',messageId:'om_unrelated',profile:'other',senderId:'ou_stranger'},
    ];
  });
  await click(official,'ou_member','lifetime',after,'my_checkin_points');
  await until(() => sent.some(m => m.receiveId === 'ou_member' && /累计 5 积分 · 签到 3 · 提问 2/.test(m.content.text)));
  assert.equal(adminUsage(await store.read(),{chatId:'oc_group',start:'2026-11-21',end:'2026-11-27'}).summary.points,3);

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

test('official receipts add historical points from verified cross-assistant authors without merging names', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(),'os-checkin-identity-'));
  const store = new JsonStore(path.join(dir,'agentos.json'));
  const sent = [], reads = [];
  const group = 'oc_shared';
  const people = [
    ['ltx','ou_clicker','om_local'],
    ['tpm','ou_linked','om_history'],
    ['tpm','ou_unrelated','om_sameName'],
  ];
  const names = new Map(people.map(([profile,id]) => [JSON.stringify([profile,group,id]),'同名员工']));
  const context = {
    store,
    projects:{chatProfileProjectMap:{[group]:{ltx:'ltx',tpm:'tpm'}}},
    agents:{agents:{ltx:{profile:'ltx',systemAssistant:true},tpm:{profile:'tpm',systemAssistant:true}}},
    adminUsageDirectory:{async names(){return names;}},
    feishu:{
      async getMessage(id,{profile}){
        reads.push([id,profile]);
        const senderId = id === 'om_history'
          ? (profile === 'ltx' ? 'ou_clicker' : 'ou_linked')
          : (profile === 'ltx' ? 'ou_other' : 'ou_unrelated');
        return {message_id:id,chat_id:group,sender:{id:senderId,id_type:'open_id',sender_type:'user',tenant_key:'same-company'}};
      },
      async sendCheckinMessage(options){
        sent.push(options);
        return {data:{message_id:'om_'+sent.length,chat_id:options.receiveIdType==='chat_id'?group:'oc_dm'}};
      },
    },
  };
  context.checkinQueue = new CheckinQueue(context);
  t.after(async () => {
    await context.checkinQueue.close();
    await rm(dir,{recursive:true,force:true});
  });
  await store.transact(state => {
    state.conversations = people.map(([profile,senderId,messageId]) => ({
      id:messageId,messageId,profile,senderId,chatId:group,chatType:'group',createdAt:'2026-11-04T02:00:00Z',
      archivedAt:'2026-11-20T00:00:00Z',content:'请核对预算金额',
    }));
  });
  const card = await publishCheckinCard(context,{profile:'ltx',group});
  const click = (action,event_id) => handleCheckinAction(context,{
    agent_profile:'ltx',operator_id:'ou_clicker',event_id,message_id:card.messageId,chat_id:group,
  },action,Date.parse('2026-11-24T00:00:00+08:00'));
  await click('daily_checkin','first');
  await until(() => sent.some(item => item.content.text === '11月24日获得 1 积分\n累计积分 3'));
  await click('my_checkin_points','lookup');
  await until(() => sent.some(item => item.content.text?.includes('累计 3 积分 · 签到 1 · 提问 2')));
  assert.equal(Object.keys((await store.read()).checkins).length,1);
  assert.equal(reads.filter(([id]) => id==='om_history').length,2);
  assert.ok(reads.some(([id]) => id==='om_sameName'));
});

test('private shop pages update the same card in order and keep checkout and signing separate', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'os-shop-pages-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new JsonStore(path.join(dir,'agentos.json'));
  const profile='demo', sent=[], updates=[];
  let failUpdate=false;
  const context={store,projects:{humanIdentities:{groupOwner:{demo:'ou_owner'}}},
    agents:{agents:{demo:{profile,systemAssistant:true}}},feishu:{
      async sendCheckinMessage(data){sent.push(data);return {data:{message_id:'om_shop',chat_id:'oc_dm'}};},
      async updateCard(id,card,options){
        assert.equal(id,'om_shop');
        assert.equal(options.profile,profile);
        if(failUpdate)throw Error('temporary delivery failure');
        updates.push(card);
      },
    }};
  const tile = content => ({tag:'column',elements:[
    {tag:'markdown',content},
    {tag:'button',behaviors:[{type:'callback',value:{action:'points_store'}}]},
  ]});
  const panel = (label,...names) => ({tag:'collapsible_panel',header:{title:{content:label}},
    elements:[{tag:'column_set',columns:names.map(tile)}]});
  const pointsStorePreviewCard={schema:'2.0',config:{},header:{title:{content:'AgentOS 积分商城'}},
    body:{elements:[panel('视频 · 2 款','B 站','腾讯'),panel('饮品 · 2 款','咖啡','奶茶')]}};
  const request={profile,previewRequestId:'paged-demo',pointsStorePreviewCard,paginatePointsStore:true};
  const receipt=await publishCheckinCard(context,request);
  const first=JSON.stringify(sent[0].content);
  assert.match(first,/第 1 \/ 2 组/);
  assert.doesNotMatch(first,/咖啡/);
  assert.equal((await publishCheckinCard(context,request)).messageId,receipt.messageId);
  assert.equal(sent.length,1);
  const click=(step,revision,id,operator='ou_owner',chat='oc_dm')=>handleCheckinAction(context,{
    event_id:id,operator_id:operator,agent_profile:profile,message_id:receipt.messageId,chat_id:chat,
    action_value:JSON.stringify({action:'points_store_page',step,revision}),
  },'points_store_page');
  assert.equal((await click(1,0,'wrong','ou_other')).ignored,true);
  assert.equal((await click(1,0,'other-chat','ou_owner','oc_other')).ignored,true);
  assert.equal((await click(-1,0,'out-of-range')).ignored,true);
  failUpdate=true;
  await assert.rejects(click(1,0,'next'),/temporary delivery failure/);
  failUpdate=false;
  assert.equal((await click(1,0,'next')).ok,true);
  assert.equal((await click(1,0,'next')).duplicate,true);
  assert.equal((await click(-1,0,'stale')).ignored,true);
  assert.equal(updates.length,1);
  assert.match(JSON.stringify(updates[0]),/第 2 \/ 2 组.*咖啡/);
  const outcomes=await Promise.all([click(-1,1,'back1'),click(-1,1,'back2')]);
  assert.equal(outcomes.filter(result=>result.ok).length,1);
  assert.equal(updates.length,2);
  assert.match(JSON.stringify(updates[1]),/第 1 \/ 2 组/);
  const s=await store.read();
  assert.equal(Object.values(s.checkinReceipts??{}).length,0);
  assert.equal(Object.values(s.checkins??{}).length,0);
});
