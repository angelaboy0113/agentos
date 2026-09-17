import { createHash } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { runLarkCli } from './lark-cli.js';
const id = x => typeof x === 'string' ? x : x?.open_id;
function messages(data) {
  const rows = data?.messages;
  if (!Array.isArray(rows)) throw new Error('Unexpected message list response');
  return rows.flatMap(m => [m, ...(Array.isArray(m.thread_replies) ? m.thread_replies : m.thread_replies?.messages ?? [])]);
}
export class EditedMentionWatcher {
  constructor(source, chats, options = {}, adapters = {}) {
    this.source=source; this.chats=[...new Set(chats)]; this.seen=new Map(); this.baselined=new Set();
    this.intervalMs=options.intervalMs ?? 30000; this.lookbackMinutes=options.lookbackMinutes ?? 60;
    this.list=adapters.list ?? (async chat => {
      const r=await runLarkCli(['im','+chat-messages-list','--as','bot','--chat-id',chat,'--start',new Date(Date.now()-this.lookbackMinutes*60000).toISOString(),'--page-size','50','--page-all','--page-limit','2','--no-reactions'],source.config);
      if (r.data?.has_more || r.meta?.pagination?.complete===false) throw new Error('Message scan truncated');
      return messages(r.data);
    });
    this.deliver=adapters.deliver ?? (event=>source.handleLine(JSON.stringify(event)));
    this.save=adapters.save ?? (async status=>{const p=path.join(source.config.cwd,'edited-mentions-status.json');await writeFile(p+'.tmp',JSON.stringify(status),{mode:0o600});await rename(p+'.tmp',p);});
    this.stopped=false;
  }
  start() { this.running=this.tick(); }
  stop() { this.stopped=true; clearTimeout(this.timer); }
  async tick() {
    try { await this.scan(); } finally { if(!this.stopped)this.timer=setTimeout(()=>{this.running=this.tick();},this.lastFailed?300000:this.intervalMs); }
  }
  async scan() {
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
          const previous=this.seen.get(key);
          const mentions=m.mentions ?? [];
          const sender=m.sender ?? {};
          const senderId=sender.open_id ?? ((sender.id_type==='open_id' || /^ou_[A-Za-z0-9]+$/.test(sender.id ?? '')) ? sender.id : null);
          if(baseline && m.updated===true && previous!==hash && !m.deleted && (sender.sender_type ?? sender.type)==='user' && senderId
            && mentions.some(x=>id(x.id ?? x.open_id)===this.source.config.botOpenId)) {
            await this.deliver({type:'im.message.receive_v1',message_id:m.message_id,chat_id:chat,chat_type:'group',
              sender_type:'user',sender_id:senderId,message_type:m.msg_type,content:m.content,mentions:mentions.map(x=>({...x,id:id(x.id ?? x.open_id)})),
              thread_id:m.thread_id,root_id:m.root_id,reply_to:m.parent_id,edited_mention:true});
            accepted++;
          }
          this.seen.set(key,hash);
        }
        this.baselined.add(chat);
      } catch { failures.push({chat,reason:'消息补查不可用：请核对机器人读取群消息权限、群成员身份或接口返回；未切换用户身份。'}); }
    }
    while(this.seen.size>3000)this.seen.delete(this.seen.keys().next().value);
    this.lastFailed=failures.length>0;
    await this.save({checkedAt:new Date().toISOString(),accepted,failures,mode:'edited-mention-poll-v1',baselineOnlyOnStartup:true}).catch(()=>{});
  }
}
