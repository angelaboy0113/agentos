import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { runLarkCli } from './lark-cli.js';
const id = x => typeof x === 'string' ? x : x?.open_id ?? x?.app_id;
export function editedMessageRows(data) {
  const rows = data?.messages;
  if (!Array.isArray(rows)) throw new Error('Unexpected message list response');
  return rows.flatMap(m => {if(m.thread_replies_error||m.thread_replies?.has_more)throw new Error('Thread scan incomplete');return [m,...(Array.isArray(m.thread_replies)?m.thread_replies:m.thread_replies?.messages??[]).map(reply=>({...reply,root_id:reply.root_id??m.message_id}))];});
}
export class EditedMentionWatcher {
  constructor(source, chats, options = {}, adapters = {}) {
    this.source=source; this.chats=[...new Set(chats)]; this.seen=new Map(); this.baselined=new Set();
    this.intervalMs=options.intervalMs ?? 30000; this.lookbackMinutes=options.lookbackMinutes ?? 60;
    this.list=adapters.list ?? (async chat => {
      const r=await runLarkCli(['im','+chat-messages-list','--as','bot','--chat-id',chat,'--start',new Date(Date.now()-this.lookbackMinutes*60000).toISOString(),'--page-size','50','--page-all','--page-limit','1000','--no-reactions'],source.config);
      if (r.data?.has_more || r.meta?.pagination?.complete===false) throw new Error('Message scan truncated');
      return editedMessageRows(r.data);
    });
    this.deliver=adapters.deliver ?? (event=>source.handleLine(JSON.stringify(event)));
    this.save=adapters.save ?? (async status=>{const p=path.join(source.config.cwd,'edited-mentions-status.json');await writeFile(p+'.tmp',JSON.stringify(status),{mode:0o600});await rename(p+'.tmp',p);});
    this.scope=createHash('sha256').update(JSON.stringify([source.config.profile,source.config.botOpenId,source.config.botAppId,this.chats])).digest('hex');
    this.load=adapters.load ?? (async()=>{if(!source.config.cwd)return null;try{return JSON.parse(await readFile(path.join(source.config.cwd,'edited-mentions-status.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}});
    this.loaded=false;this.stopped=false;
  }
  start() { this.running=this.tick(); }
  stop() { this.stopped=true; clearTimeout(this.timer); }
  async tick() {
    try { await this.scan(); } finally { if(!this.stopped)this.timer=setTimeout(()=>{this.running=this.tick();},this.lastFailed?300000:this.intervalMs); }
  }
  async scan() {
    if(this.scanning)return this.scanning;
    const work=this.scanOnce();this.scanning=work;try{return await work;}finally{this.scanning=null;}
  }
  async scanOnce() {
    if(!this.loaded){
      try{const saved=await this.load(),c=saved?.checkpoint;
        if(c?.version===2&&c.scope===this.scope&&Array.isArray(c.entries)&&Array.isArray(c.chats)){
          this.seen=new Map(c.entries.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&typeof x[1]?.hash==='string'&&Number.isFinite(x[1]?.lastSeenAt)));
          this.baselined=new Set(c.chats.filter(x=>this.chats.includes(x)));
        }
      }catch{this.lastFailed=true;await this.save({checkedAt:new Date().toISOString(),accepted:0,failures:[{reason:'编辑补查检查点不可读取；未重放旧消息'}],mode:'edited-mention-poll-v2'}).catch(()=>{});return;}
      this.loaded=true;
    }
    const failures=[]; let accepted=0;
    for(const chat of this.chats) {
      if(this.stopped)break;
      try {
        const rows=await this.list(chat), baseline=this.baselined.has(chat);
        for(const m of rows) {
          if(this.stopped)break;
          if(!m.message_id)continue;
          const key=chat+':'+m.message_id;
          const hash=createHash('sha256').update(JSON.stringify([m.content,m.mentions,m.deleted])).digest('hex');
          const previous=this.seen.get(key)?.hash;
          const mentions=m.mentions ?? [];
          const sender=m.sender ?? {};
          const senderId=sender.open_id ?? ((sender.id_type==='open_id' || /^ou_[A-Za-z0-9]+$/.test(sender.id ?? '')) ? sender.id : null);
          if(baseline && m.updated===true && previous!==hash && !m.deleted && (sender.sender_type ?? sender.type)==='user' && senderId
            && mentions.some(x=>[this.source.config.botOpenId,this.source.config.botAppId].filter(Boolean).includes(id(x.id ?? x.open_id)))) {
            await this.deliver({type:'im.message.receive_v1',message_id:m.message_id,chat_id:chat,chat_type:'group',
              sender_type:'user',sender_id:senderId,message_type:m.msg_type,content:m.content,mentions:mentions.map(x=>{const raw=id(x.id??x.open_id);return {...x,id:raw===this.source.config.botAppId?this.source.config.botOpenId:raw};}),
              thread_id:m.thread_id,root_id:m.root_id,reply_to:m.parent_id,edited_mention:true});
            accepted++;
          }
          this.seen.set(key,{hash,lastSeenAt:Date.now()});
        }
        if(!this.stopped)this.baselined.add(chat);
      } catch(error) { failures.push({chat,code:/(?:230027|230073|99991672)/.exec(String(error?.message))?.[0]??null,reason:'消息补查不可用：请核对机器人读取群消息权限、群成员身份或接口返回；未切换用户身份。'}); }
    }
    for(const [key,value] of this.seen)if(Date.now()-value.lastSeenAt>this.lookbackMinutes*60000)this.seen.delete(key);
    this.lastFailed=failures.length>0;
    await this.save({checkedAt:new Date().toISOString(),accepted,failures,mode:'edited-mention-poll-v2',baselineOnlyOnFirstSetup:true,lookbackMinutes:this.lookbackMinutes,checkpoint:{version:2,scope:this.scope,chats:[...this.baselined],entries:[...this.seen]}}).catch(()=>{});
  }
}
