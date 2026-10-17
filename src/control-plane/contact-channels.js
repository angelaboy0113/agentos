import {readFile} from 'node:fs/promises';
import {conversationCard} from './message-cards.js';
import {cardDestination} from './private-cards.js';
const human=id=>typeof id==='string'&&/^ou_[A-Za-z0-9]+$/.test(id);
export function contactChannelSettings(value={}){
 const channels=value.channels??[];
 if(!Array.isArray(channels)||channels.some(c=>!c||['chatId','profile','projectId'].some(k=>typeof c[k]!=='string'||!c[k].trim())||c.audience!=='requester_and_owner')||new Set(channels.map(c=>c.chatId)).size!==channels.length)throw new Error('Invalid contact channel configuration');
 return {channels};
}
export class ContactChannels{
 constructor(context,{file,settings}={}){this.context=context;this.file=file??'./config/contact-channels.local.json';this.fixed=settings;}
 async settings(){if(this.fixed)return contactChannelSettings(this.fixed);try{return contactChannelSettings(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if(e.code==='ENOENT')return {channels:[]};throw e;}}
 async channel(chatId){return (await this.settings()).channels.find(c=>c.chatId===chatId);}
 async resolve(chatId,profile,senderId){const config=await this.channel(chatId);if(!config)return null;
  if(config.profile!==profile||this.context.projects.chatProjectMap[chatId]!==config.projectId)throw new Error('查人专用群身份或项目配置不匹配');
  const info=await this.context.feishu.chatInfo(chatId,{profile});
  if(info.chat_mode!=='group'||info.group_message_type&&info.group_message_type!=='chat'||!human(info.owner_id)||info.owner_id===this.context.agents?.agents?.owner_intake?.openId||!human(senderId))throw new Error('查人专用群必须是普通群并能核实真人群主');
  return {...config,ownerId:info.owner_id};
 }
 async verifyDestination(destination){if(!destination.contactChannel)return;
  const c=destination.contactChannel,current=await this.resolve(c.chatId,destination.profile,c.requesterId);
  const state=await this.context.store.read(),latestId=state.questions?.[destination.questionId]?.latestTurnId;
  if(destination.sourceTurnId&&latestId!==destination.sourceTurnId)throw new Error('已有新的查人补充，旧群主副本不再发送');
  if(!current||current.ownerId!==c.ownerId||current.projectId!==c.projectId||![c.requesterId,current.ownerId].includes(destination.openId))throw new Error('查人群配置、群主或收件范围已变化，未发送旧结果');
  const turn=state.conversations?.find(t=>t.id===(destination.sourceTurnId??latestId));
  if(turn?.outcome?.contactImage)await this.context.contacts.validateImage(turn,turn.outcome.contactImage);
 }
 async deliver(turn){
  const current=await this.resolve(turn.chatId,turn.profile,turn.senderId);
  if(!current||current.ownerId!==turn.directoryChannel.ownerId)throw new Error('群主已变化，请重新发起查人问题');
  let imageKey=turn.contactImageKey;
  if(turn.outcome?.contactImage){const file=await this.context.contacts.validateImage(turn,turn.outcome.contactImage);
   if(!imageKey){const result=await this.context.feishu.uploadImage(file,{profile:turn.profile});imageKey=imageKeyOf(result);if(!imageKey)throw new Error('联系人图片上传未返回资源编号');await this.context.store.transact(s=>{s.conversations.find(t=>t.id===turn.id).contactImageKey=imageKey;});}
  }
  const state=await this.context.store.read(),question=state.questions?.[turn.questionId];
  if(question&&question.latestTurnId!==turn.id)return [];
  const base=question?cardDestination(question):cardDestination(turn);
  const card=conversationCard({...turn,response:turn.response});
  if(imageKey)card.body.elements.unshift({tag:'img',img_key:imageKey,alt:{tag:'plain_text',content:'联系人资料：姓名、岗位和完整部门路径'},scale_type:'fit_horizontal',preview:true});
  const key=question?'question:'+question.id:'chat:'+turn.id;
  const ids=[...new Set([turn.senderId,current.ownerId])],results=[];let primaryError;
  for(const id of ids){const destination={...base,openId:id,sourceKey:key,...(id!==turn.senderId?{sourceTurnId:turn.id}:{})};const target=id===turn.senderId?key:'directory-owner:'+turn.id;
   try{results.push(await this.context.cards.upsert(target,card,destination,{terminal:true,immediate:true,resultText:turn.response??'',guard:s=>{if(question&&(s.questions?.[question.id]?.latestTurnId!==turn.id||s.questions[question.id].generation!==question.generation))throw new Error('查人问题已有新补充，跳过旧结果');},...(question&&id===turn.senderId?{generation:question.generation}:{} )}));}
   catch(error){if(id===turn.senderId)primaryError=error;} // Every failed audience copy remains in the delivery outbox.
  }
  if(primaryError)throw primaryError;
  return results.filter(Boolean);
 }
}
function imageKeyOf(value){if(!value||typeof value!=='object')return null;if(typeof value.image_key==='string')return value.image_key;for(const child of Object.values(value)){const key=imageKeyOf(child);if(key)return key;}return null;}
