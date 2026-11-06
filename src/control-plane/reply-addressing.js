import {readFile} from 'node:fs/promises';

const clean = value => typeof value === 'string' && value.length <= 80 && !/[<>\[\]{}\r\n\u0000-\u001f]/.test(value) ? value.normalize('NFKC').trim() : '';
const compoundSurnames = /^(?:欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|司徒|司空|夏侯|令狐|宇文|长孙|南宫|万俟|闻人|澹台|公羊|赫连|申屠|端木|独孤|仲孙|钟离|濮阳|宗政|太史|太叔|闾丘|东郭|呼延|羊舌|百里|第五)/;
const singleSurnames = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫房裘缪解应宗丁宣邓郁单杭洪包左石崔吉龚程嵇邢裴陆荣翁荀羊甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶黎赖卓蔺屠蒙池乔谭胥申冉雍桑桂濮牛寿通边燕冀浦尚农温别庄晏柴瞿阎连茹习艾鱼容向古易慎廖庾终居衡步都耿满弘匡文寇广禄阙东欧利师巩聂晁曾毋沙鞠丰关查游权盖桓公楚来覃'.split(''));
export function addressingSettings(value = {}) {
  if(value.enabled !== undefined && typeof value.enabled !== 'boolean') throw Error('Invalid reply addressing switch');
  for(const key of ['profiles','chatIds']) if(value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(x => typeof x !== 'string' || !x.trim()))) throw Error('Invalid reply addressing scope');
  if(value.enabledSince !== undefined && (!Number.isFinite(Date.parse(value.enabledSince)) || !/T/.test(value.enabledSince))) throw Error('Invalid reply addressing activation');
  const overrides=value.displayNameOverrides??{};
  if(!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.entries(overrides).some(([k,v])=>!clean(k)||!clean(v))) throw Error('Invalid reply addressing names');
  if(value.fallback !== undefined && value.fallback !== '' && !clean(value.fallback)) throw Error('Invalid reply addressing fallback');
  return {enabled:value.enabled===true,profiles:value.profiles??[],chatIds:value.chatIds??[],enabledSince:value.enabledSince??null,
    displayNameOverrides:overrides,fallback:value.fallback??''};
}
// Display names are presentation only. No gender inference, permissions or ID mapping.
export function salutation(name, settings) {
  name=clean(name);
  if(!name)return settings.fallback;
  if(Object.hasOwn(settings.displayNameOverrides,name))return clean(settings.displayNameOverrides[name]);
  if(name.endsWith('老师'))return name;
  const short=/^[\u3400-\u9fff]{3}$/.test(name)&&singleSurnames.has(name[0])&&!compoundSurnames.test(name)?name.slice(1):name;
  return short+'老师';
}
export function addressText(text, name) {
  if(!name || typeof text !== 'string' || !text.trim() || text.trimStart().startsWith(name))return text;
  return name+(/^[\s]*(?:#|```|>|\|)/.test(text)?'，\n\n':'，')+text;
}
export function addressCard(card, name) {
  if(!name)return card;
  const copy=structuredClone(card);
  function visit(node){
    if(!node||typeof node!=='object')return false;
    if(node.tag==='markdown'&&node.text_size!=='notation'&&typeof node.content==='string'&&node.content.trim()){node.content=addressText(node.content,name);return true;}
    for(const value of Object.values(node))if(Array.isArray(value)){for(const item of value)if(visit(item))return true;}else if(value&&typeof value==='object'&&visit(value))return true;
    return false;
  }
  const first=copy.body?.elements?.[0];
  const answer=first?.tag==='markdown'||first?.tag==='column_set'&&first.columns?.length===1?first:null;
  if((!answer||!visit(answer))&&Array.isArray(copy.body?.elements))copy.body.elements.unshift({tag:'markdown',content:name+'：'});
  return copy;
}
export class ReplyAddressing {
  constructor(context,{file=context.config.replyAddressingFile,settings,now=Date.now,lookupMs=2000}={}){this.context=context;this.file=file;this.fixed=settings;this.now=now;this.lookupMs=lookupMs;this.cache=new Map();this.flights=new Map();}
  async settings(){if(this.fixed)return addressingSettings(this.fixed);try{return addressingSettings(JSON.parse(await readFile(this.file,'utf8')));}catch{return addressingSettings();}}
  async forTurn(turn){
    const settings=await this.settings(),profile=turn?.profile??turn?.originProfile;
    for(const [key,value] of this.cache)if(this.now()-value.at>900000)this.cache.delete(key);
    if(!settings.enabled||!settings.profiles.includes(profile)||!settings.chatIds.includes(turn?.chatId)||!turn?.senderId
      ||settings.enabledSince&&!(Date.parse(turn.createdAt)>=Date.parse(settings.enabledSince)))return '';
    const key=JSON.stringify([profile,turn.chatId]);
    let entry=this.cache.get(key);
    if(!entry||this.now()-entry.at>(entry.failed?60000:900000)){
      if(!this.flights.has(key)){
        let timer;
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Name lookup deferred')),this.lookupMs);});
        const flight=Promise.race([this.members(turn.chatId,profile),timeout]).finally(()=>clearTimeout(timer)).then(names=>({at:this.now(),names,failed:false}),()=>({at:this.now(),names:new Map(),failed:true})).then(result=>{this.cache.set(key,result);return result;});
        this.flights.set(key,flight);flight.finally(()=>this.flights.delete(key));
      }
      entry=await this.flights.get(key);
    }
    return salutation(entry.names.get(turn.senderId),settings);
  }
  async members(chatId,profile){
    if(typeof this.context.feishu.groupMembersPage!=='function')throw Error('Member names unavailable');
    const names=new Map(),seen=new Set(),deadline=this.now()+this.lookupMs;let token;
    do{
      const remaining=deadline-this.now();if(remaining<=0)throw Error('Name lookup deferred');
      const page=await this.context.feishu.groupMembersPage(chatId,{pageToken:token},{profile,timeoutMs:remaining});
      for(const item of page.items??[])if(typeof item.member_id==='string'&&clean(item.name))names.set(item.member_id,clean(item.name));
      if(!page.has_more)return names;
      if(typeof page.page_token!=='string'||!page.page_token||seen.has(page.page_token))throw Error('Incomplete member names');
      token=page.page_token;seen.add(token);
    }while(true);
  }
}
