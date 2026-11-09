import {isAdministrator} from './authorization.js';
const cleanName=x=>typeof x==='string'&&!/[<>\r\n\x00-\x1f]/.test(x)&&x.length<=100?x.trim():'';
const keyOf=t=>JSON.stringify([t.profile,t.chatId,t.senderId]);
const dateParts=(value,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
function category(t){
 const text=String(t.content??'').trim();if(!text&&!(t.attachments??[]).length)return 'empty';const compact=text.replace(/[\s，,。.!！?？]/g,'').toLowerCase();
 if(/password|passwd|密码|secret|token\s*[:：=]|账号\s*[:：]/i.test(text)||t.credentialSubmission)return 'sensitive';
 if(/^(?:prd|sit|uat|生产|正式|测试)(?:环境|机|的|生产环境|测试环境)?$/.test(compact))return 'clarification';
 if(/^(?:停止|取消|停止任务|取消任务)$/.test(compact))return 'control';
 if(t.decision?.responseStyle==='social'||t.decision?.receptionIntent==='social'||/^(?:谢谢|好的|收到|哈哈|好嘞|我看看|稍等我看看|满意死了)[！!。\s]*$/.test(text))return 'social';
 return 'business';
}
export function adminUsage(state,query={}, {projects={},names=new Map(),now=Date.now(),allRecords=false}={}){
 const zone=query.timeZone||'Asia/Shanghai';try{dateParts(now,zone);}catch{throw Error('Invalid statistics time zone');}
 for(const k of ['start','end'])if(query[k]&&(!/^\d{4}-\d{2}-\d{2}$/.test(query[k])||!Number.isFinite(Date.parse(query[k]))||new Date(query[k]).toISOString().slice(0,10)!==query[k]))throw Error('Invalid statistics date');
 if(query.start&&query.end&&query.start>query.end)throw Error('Start date must not exceed end date');
 const scope=query.scope==='all'?'all':'business', grouping=query.grouping==='identity'?'identity':'name',excludeAdmin=query.excludeAdmin!=='false';
 const seen=new Set(),rows=[],excluded={private:0,duplicate:0,sensitive:0,administrator:0,nonBusiness:0,invalid:0};
 for(const t of [...(state.conversations??[])].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))){
  if(t.visibility==='private'||t.chatType==='p2p'||Object.values(state.questions??{}).find(q=>q.id===t.questionId)?.visibility==='private'){excluded.private++;continue;}
  if(!t.senderId||!t.profile||!t.messageId||!Number.isFinite(Date.parse(t.createdAt))){excluded.invalid++;continue;}
  const dedup=JSON.stringify([t.profile,t.chatId,t.messageId]);if(seen.has(dedup)){excluded.duplicate++;continue;}seen.add(dedup);
  const day=dateParts(t.createdAt,zone);if(query.start&&day<query.start||query.end&&day>query.end||query.profile&&query.profile!==t.profile||query.projectId&&query.projectId!==t.projectId||query.chatId&&query.chatId!==t.chatId)continue;
  const kind=category(t);if(kind==='sensitive'){excluded.sensitive++;continue;}
  if(excludeAdmin&&isAdministrator(projects,t)){excluded.administrator++;continue;}
  if(scope==='business'&&kind!=='business'){excluded.nonBusiness++;continue;}
  const name=cleanName(names.get(keyOf(t)))||cleanName(t.senderName)||'',linked=Object.entries(projects.humanIdentities??{}).find(([,m])=>m[t.profile]===t.senderId)?.[0];
  const personKey=linked?`human:${linked}`:grouping==='name'&&name?`name:${name}`:`actor:${JSON.stringify([t.profile,t.senderId])}`;
  const job=(state.jobs??[]).find(j=>j.id===t.decision?.jobId)||(state.jobs??[]).find(j=>j.sourceMessageId===t.messageId&&j.originProfile===t.profile);
  rows.push({id:t.id,personKey,name:name||'姓名暂不可用',profile:t.profile,projectId:t.projectId??'',chatId:t.chatId,questionId:t.questionId??null,createdAt:t.createdAt,day,kind,points:kind==='business'?1:0,followup:!!t.parentId,title:String(t.content??'').slice(0,240),...(allRecords?{question:String(t.content??'')}:{}),status:job?.status??t.status,recordId:job?.id??t.id,sourceEnvironment:job?.sourceEnvironment??t.decision?.sourceEnvironment??null});
 }
 const group=(field)=>{const m=new Map();for(const r of rows){const key=r[field];m.set(key,(m.get(key)??0)+1);}return [...m].map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count||String(a.key).localeCompare(String(b.key)));};
 const people=new Map();for(const r of rows){let p=people.get(r.personKey);if(!p){p={key:r.personKey,name:r.name,count:0,points:0,followups:0,profiles:{},lastAt:r.createdAt};people.set(r.personKey,p);}p.count++;p.points+=r.points;p.followups+=Number(r.followup);p.profiles[r.profile]=(p.profiles[r.profile]??0)+1;if(r.createdAt>p.lastAt)p.lastAt=r.createdAt;}
 const ranking=[...people.values()].sort((a,b)=>b.points-a.points||b.count-a.count||a.name.localeCompare(b.name));let last=-1,rank=0;for(let i=0;i<ranking.length;i++){if(ranking[i].points!==last)rank=i+1;last=ranking[i].points;ranking[i].rank=rank;}
 const selected=rows.filter(r=>!query.person||r.personKey===query.person).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const page=Math.max(1,Number.parseInt(query.page)||1),pageSize=50;
 const profileOptions=[...new Map((state.conversations??[]).filter(t=>t.chatType!=='p2p'&&t.visibility!=='private'&&t.profile).map(t=>[t.profile,{key:t.profile,label:projects.projects?.[t.projectId]?.displayName??t.profile}])).values()];
 return {selection:{profile:query.profile??'',projectId:query.projectId??'',chatId:query.chatId??'',person:query.person??''},profileOptions,filters:{scope,grouping,excludeAdmin,timeZone:zone,start:query.start??'',end:query.end??''},summary:{points:rows.reduce((n,r)=>n+r.points,0),messages:rows.length,people:people.size,followups:rows.filter(r=>r.followup).length},ranking,assistants:group('profile'),projects:group('projectId'),timeline:group('day').sort((a,b)=>a.key.localeCompare(b.key)),records:allRecords?selected:selected.slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total:selected.length,pages:Math.ceil(selected.length/pageSize)},excluded,coverage:{firstAt:(state.conversations??[]).map(t=>t.createdAt).filter(Boolean).sort()[0]??null,retentionDays:state.retention?.days??30},pointRule:'每条有效业务提问或追问1分，不以任务成功与否计分；闲聊、环境补充、控制指令0分。按当前筛选范围及留存记录计算，不是永久累计账户。',method:'按机器人身份、群和原消息去重；仅留存记录。业务分类为规则估计，非人工周榜复核；同名合并仅用于展示，不作身份或权限依据。追问标记依据原话题引用，非新任务数；提问数不等于解决数。'};
}
// Names are fetched with each bot's own existing group-read permission, never used for authorization.
export class AdminUsageDirectory{
 constructor(context){this.context=context;this.cache=new Map();this.flight=null;}
 async names(state){if(this.flight)return this.flight;this.flight=this.load(state).finally(()=>{this.flight=null;});return this.flight;}
 async load(state){const out=new Map(),pairs=new Map();for(const t of state.conversations??[])if(t.profile&&t.chatId&&t.chatType!=='p2p'&&t.visibility!=='private')pairs.set(JSON.stringify([t.profile,t.chatId]),t);
 await Promise.all([...pairs].map(async([key,t])=>{let v=this.cache.get(key);if(!v||Date.now()-v.at>(v.failed?60000:900000)){try{v={at:Date.now(),names:await this.context.replyAddressing.members(t.chatId,t.profile)};}catch{v={at:Date.now(),names:v?.names??new Map(),failed:true};}this.cache.set(key,v);}for(const [id,name]of v.names)out.set(keyOf({...t,senderId:id}),name);}));return out;}
}
