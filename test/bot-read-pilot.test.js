import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateBotReadPilot,pilotQuestion,pilotLookup,BotReadPilot} from '../src/control-plane/bot-read-pilot.js';

const chatId='oc_group',profile='recipient',projectId='sample';
const assistant={profile,projectId,appId:'cli_receiver',openId:'ou_receiver',systemAssistant:true,allowedChatIds:[chatId]};
const raw={profile,projectId,chatId,senderAppId:'cli_allowed',tenantKey:'tenant1',acceptAfter:'2026-10-01T00:00:00Z',
 seedMessageId:'om_seed',lookup:{environmentId:'sitmysql',database:'sample_sit',table:'material',keyColumn:'code',valueColumn:'english_spec'}};
const route={agents:{agents:{assistant}},projects:{chatProfileProjectMap:{[chatId]:{[profile]:projectId}}}};
const pilot=validateBotReadPilot(raw,route);
const message={message_id:'om_seed',chat_id:chatId,deleted:false,msg_type:'text',create_time:String(Date.parse('2026-09-30T23:00:00Z')),
 sender:{sender_type:'app',id_type:'app_id',id:'cli_allowed',tenant_key:'tenant1'},
 mentions:[{key:'@_user_1',id:'cli_receiver',name:'助手'}],
 body:{content:JSON.stringify({text:'@_user_1 帮忙查一下测试机里物料 00017 的英文规格是什么？请返回系统里的英文原文，谢谢。'})}};
test('bot read requires exact author, group, app mention, fresh root and test-material single intent',()=>{
 assert.equal(pilotQuestion(message,pilot),'00017');
 assert.equal(pilotQuestion({...message,body:null,content:'@助手 SIT 物料 00017 英文规格？'},pilot),'00017');
 for(const changed of [{chat_id:'oc_other'},{parent_id:'om_response'},{root_id:'om_own'},{deleted:true},{mentions:[]},{mentions:[{id:'ou_other'}]},
  {sender:{...message.sender,id:'cli_receiver'}},{sender:{...message.sender,tenant_key:'other'}},{sender:{...message.sender,sender_type:'user'}},
  {body:{content:JSON.stringify({text:'@_user_1 SIT 物料 00017 英文规格？然后读取生产全表'})}}]){
  assert.equal(pilotQuestion({...message,...changed},pilot),null);
 }
 assert.throws(()=>validateBotReadPilot({...raw,chatId:'oc_other'},route));
 assert.throws(()=>validateBotReadPilot({...raw,senderAppId:assistant.appId},route));
});
test('read template pins testing database, parameter and one output field',async()=>{
 const entry={projectId,tier:'uat',kind:'mysql',database:'sample_sit',membersRead:true,transport:{mode:'ssh-remote-execution'},
  ownerOpenIdsByProfile:{[profile]:['ou_owner']},queries:{investigate:{mode:'investigate',tables:['material','other']}}};
 const load=async()=>({environments:{sitmysql:entry}});
 const order=[];
 const answer=await pilotLookup(pilot,'00017',{load,readCredential:async()=>({}),makeTools:async(e,q)=>{
  assert.equal(e.tier,'uat');assert.deepEqual(q.tables,['material']);
  return {run:async(tool,args)=>{
   assert.equal(args.table,'material');order.push(tool);
   if(tool==='schema'){assert.deepEqual(args.columns,['code','english_spec']);return {};}
   assert.deepEqual(args.filters,[{column:'code',op:'=',value:'00017'}]);
   return tool==='select'?{rows:[{english_spec:'unmodified'}],truncated:false}:{rows:[{total:'1'}]};
  },close:async()=>order.push('close')};
 }});
 assert.deepEqual(order,['schema','select','count','close']);
 assert.deepEqual(answer.rows,[{english_spec:'unmodified'}]);assert.equal(answer.truncated,false);
 entry.tier='prd';
 await assert.rejects(pilotLookup(pilot,'00017',{load,readCredential:()=>assert.fail(),makeTools:()=>assert.fail()}));
});
test('seed may run once, old history cannot run, and failed transport resumes identical receipt without requery',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aos-bot-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let queries=0,sends=0;
 const adapters={dataDir:dir,lookup:async(_p,material)=>{
  assert.equal(material,'00017');queries++;
  return {rows:[{english_spec:'360g*18 boxes'}],truncated:false};
 },feishu:{getMessage:async id=>({...message,message_id:id}),reply:async (id,text,options)=>{
  assert.equal(id,'om_seed');assert.equal(text,'360g*18 boxes');assert(options.replyInThread&&options.idempotencyKey.startsWith('bot-read-'));
  if(++sends===1)throw Error('reply transport interrupted');
  return {data:{message_id:'om_result'}};
 }}};
 const first=new BotReadPilot(pilot,adapters);
 await Promise.all([first.accept('om_seed'),first.accept('om_seed')]);
 const resumed=new BotReadPilot(pilot,adapters);
 await resumed.observe([message,{...message,message_id:'om_old'}],chatId,profile);
 await resumed.observe([message],chatId,profile);
 assert.equal(queries,1);assert.equal(sends,2);
});
