import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fingerprint,loadEnvironments} from '../shared/environment-access.js';
import {credential} from '../runner/environment-connector.js';
import {createEnvironmentTools} from '../runner/environment-tools.js';

const appId=/^cli_[a-z0-9]+$/i;
const messageId=/^om_[a-z0-9]+$/i;
const field=/^[a-z][a-z0-9_]{0,63}$/i;
const validKeys=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).every(key=>keys.includes(key));

export function validateBotReadPilot(config,{agents,projects}){
 if(!validKeys(config,['profile','projectId','chatId','senderAppId','tenantKey','acceptAfter','seedMessageId','lookup'])
  ||!appId.test(config.senderAppId)||!/^oc_[a-z0-9]+$/i.test(config.chatId)||!/^[a-z0-9]+$/i.test(config.tenantKey??'')
  ||!Number.isFinite(Date.parse(config.acceptAfter))||config.seedMessageId!==undefined&&!messageId.test(config.seedMessageId)
  ||!validKeys(config.lookup,['environmentId','database','table','keyColumn','valueColumn'])
  ||!Object.values(config.lookup).every(value=>typeof value==='string'&&field.test(value))
  ||Object.keys(config.lookup).length!==5)throw new Error('机器人只读试点配置无效');
 const assistant=Object.values(agents.agents).find(agent=>agent.profile===config.profile);
 if(!assistant?.systemAssistant||!assistant.allowedChatIds?.includes(config.chatId)||assistant.projectId!==config.projectId
  ||projects.retiredChatIds?.includes(config.chatId)||projects.chatProfileProjectMap?.[config.chatId]?.[config.profile]!==config.projectId
  ||!appId.test(assistant.appId)||assistant.appId===config.senderAppId||!assistant.openId)throw new Error('机器人只读试点的群、应用与系统绑定无效');
 return {...config,receiverAppId:assistant.appId,receiverOpenId:assistant.openId};
}

export function pilotQuestion(row,pilot){
 const sender=row.sender,mention=row.mentions?.length===1?row.mentions[0]:null;
 if(!messageId.test(row.message_id)||row.deleted!==false||row.msg_type!=='text'||row.chat_id!==pilot.chatId
  ||sender?.sender_type!=='app'||sender.id_type!=='app_id'||sender.id!==pilot.senderAppId||sender.tenant_key!==pilot.tenantKey
  ||!mention||![pilot.receiverAppId,pilot.receiverOpenId].includes(mention.id)
  ||row.parent_id||row.root_id&&row.root_id!==row.message_id)return null;
 let text=row.content;
 if(row.body)try{text=JSON.parse(row.body.content).text;}catch{return null;}
 if(typeof text!=='string')return null;
 const prefix=[mention.key,mention.name?'@'+mention.name:''].filter(Boolean).find(key=>text.startsWith(key+' '));
 if(!prefix)return null;
 // A closed, single-field question grammar keeps arbitrary text out of both
 // the model and database. The only database parameter is the material number.
 return /^(?:请问|请帮忙|帮忙)?\s*(?:查(?:询|一下)?\s*)?(?:测试机|测试环境|SIT(?:环境)?)(?:里|中)?\s*(?:的\s*)?物料\s*([0-9]{1,24})\s*(?:的\s*)?英文规格(?:\s*是什么)?\s*[？?。.]?(?:\s*请(?:返回|给出)(?:系统里|系统中)?的?英文原文[，,。.]?\s*(?:谢谢[。！!])?)?\s*$/i.exec(text.slice(prefix.length).trim())?.[1]??null;
}

export async function pilotLookup(pilot,material,{load=loadEnvironments,readCredential=credential,makeTools=createEnvironmentTools}={}){
 const cfg=await load(),p=pilot.lookup,entry=cfg.environments[p.environmentId];
 const source=entry?.queries?.investigate;
 if(!/^\d{1,24}$/.test(material)||entry?.projectId!==pilot.projectId||entry.tier!=='uat'||entry.kind!=='mysql'||entry.database!==p.database||!entry.membersRead||!entry.transport
  ||!entry.ownerOpenIdsByProfile[pilot.profile]?.length||source?.mode!=='investigate'||!(source.tables.includes('*')||source.tables.includes(p.table)))throw new Error('试点只读来源绑定已失效');
 const scopeHash=fingerprint(entry);
 const authorize=async()=>{
  if(fingerprint((await load()).environments[p.environmentId]??null)!==scopeHash)throw new Error('试点读取期间环境配置发生变更');
 };
 const tools=await makeTools(entry,{...source,tables:[p.table],maxRows:20,exportMaxRows:undefined},await readCredential(entry.credentialRef),{authorize});
 try{
  await authorize();
  await tools.run('schema',{table:p.table,columns:[p.keyColumn,p.valueColumn]});
  const parameters={table:p.table,filters:[{column:p.keyColumn,op:'=',value:material}]};
  const {rows,truncated}=await tools.run('select',{...parameters,columns:[p.valueColumn]});
  const count=await tools.run('count',parameters);
  await authorize();
  return {rows:rows.map(row=>({english_spec:row[p.valueColumn]})),truncated:truncated||Number(count.rows[0]?.total)!==rows.length,
   evidence:{environmentId:p.environmentId,scopeHash,rowCount:rows.length,readAt:new Date().toISOString()}};
 }finally{await tools.close();}
}

export class BotReadPilot {
 constructor(config,{dataDir,feishu,lookup=pilotLookup}){
  this.config=config;this.feishu=feishu;this.lookup=lookup;
  this.root=path.join(dataDir,'bot-read-pilot');
  this.active=new Map();this.stopped=false;
 }
 stop(){this.stopped=true;}
 async observe(rows,chat,profile){
  if(this.stopped||chat!==this.config.chatId||profile!==this.config.profile)return;
  const ids=[...new Set([this.config.seedMessageId,...rows.filter(row=>pilotQuestion(row,this.config)).map(row=>row.message_id)].filter(Boolean))];
  for(const id of ids)await this.accept(id);
 }
 accept(id){
  if(this.stopped||!messageId.test(id))return Promise.resolve();
  if(this.active.has(id))return this.active.get(id);
  const operation=this.execute(id).catch(()=>console.error('[bot-read-pilot] 查询或投递未确认，保留待处理状态')).finally(()=>this.active.delete(id));
  this.active.set(id,operation);return operation;
 }
 async execute(id){
  const p=this.config,key=createHash('sha256').update(JSON.stringify([p.profile,p.chatId,p.senderAppId,id])).digest('hex');
  const file=path.join(this.root,key+'.json');
  const saved=await readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(saved?.messageId)return;
  const row=await this.feishu.getMessage(id,{profile:p.profile});
  const material=row&&pilotQuestion(row,p);
  if(!material||row.message_id!==id||id!==p.seedMessageId&&!(Number(row.create_time)>=Date.parse(p.acceptAfter)))return;
  if(saved&&saved.material!==material)return;
  let receipt=saved;
  if(!receipt){
   const result=await this.lookup(p,material);
   const values=[...new Set(result.rows.map(row=>row.english_spec))];
   const safe=value=>typeof value==='string'&&value.trim()&&value.length<500&&!/[<>&\x00-\x1f]/.test(value);
   const text=!result.truncated&&values.length===1&&safe(values[0])?values[0]
    :!values.some(Boolean)&&!result.truncated?'测试环境未查到该物料的英文规格。'
    :'测试环境未核实到唯一的英文规格，请由提问者补充范围。';
   receipt={sourceMessageId:id,material,text,evidence:result.evidence,createdAt:new Date().toISOString()};
   await this.save(file,receipt);
  }
  if(this.stopped)return;
  const sent=await this.feishu.reply(id,receipt.text,{profile:p.profile,replyInThread:true,idempotencyKey:'bot-read-'+key});
  const sentId=sent.data?.message_id;
  if(!messageId.test(sentId))throw new Error('缺少飞书投递回执');
  await this.save(file,{...receipt,messageId:sentId,deliveredAt:new Date().toISOString()});
 }
 async save(file,receipt){
  await mkdir(this.root,{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,JSON.stringify(receipt),{mode:0o600,flag:'wx'});await rename(tmp,file);
 }
}
