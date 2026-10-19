import {readFile,mkdir,writeFile,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';import {createHash} from 'node:crypto';
import {ContactIndex} from './contact-index.js';
import {renderContactImage} from './contact-image.js';
const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const clean=v=>typeof v==='string'?v.replace(/[\u0000-\u001f]/g,' ').trim().slice(0,300):'';
export function contactSettings(value={}){
 if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw new Error('联系人enabled配置无效');
 const scopes=value.scopes??[];
 if(!Array.isArray(scopes)||scopes.some(s=>!s.projectId||!['chatIds','profiles'].every(k=>Array.isArray(s[k])&&s[k].length&&s[k].every(x=>typeof x==='string'&&x.trim()))||s.senderIds!==undefined&&(!Array.isArray(s.senderIds)||!s.senderIds.every(x=>typeof x==='string'&&x))||s.workEmailDomains!==undefined&&(!Array.isArray(s.workEmailDomains)||s.workEmailDomains.some(d=>typeof d!=='string'||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d)))))throw new Error('联系人共享范围配置无效');
 if(value.indexFreshnessMs!==undefined&&(!Number.isInteger(value.indexFreshnessMs)||value.indexFreshnessMs<0))throw new Error('联系人索引有效期无效');
 return {enabled:value.enabled===true,scopes,indexFreshnessMs:value.indexFreshnessMs??900000};
}
export function contactFields(u,workEmailDomains=[]){
 const mobile=clean(u.mobile).replace(/\D/g,'');
 const email=clean(u.email),parts=email.split('@'),approvedWorkEmail=parts.length===2&&parts[0]&&workEmailDomains.some(d=>d.toLowerCase()===parts[1].toLowerCase())?email:'';
 return {name:clean(u.name),employeeNo:clean(u.employee_no),jobTitle:clean(u.job_title),enterpriseEmail:clean(u.enterprise_email)||approvedWorkEmail,
  mobile:mobile.length>=7?mobile.slice(0,3)+'****'+mobile.slice(-4):'',departmentIds:Array.isArray(u.department_ids)?u.department_ids.filter(x=>typeof x==='string'):[],
  leaderId:clean(u.leader_user_id),joinTime:typeof u.join_time==='number'||typeof u.join_time==='string'?String(u.join_time):''};
}
const bound=t=>({id:t.id,chatId:t.chatId,senderId:t.senderId,profile:t.profile,projectId:t.projectId,questionId:t.questionId??null,messageId:t.messageId});
export class ContactDirectory{
 constructor(context,options={}){this.context=context;this.options=options;this.file=options.file??path.resolve('./config/contacts.local.json');this.render=options.render??renderContactImage;this.index=new ContactIndex(context.config.dataDir);this.directoryFlights=new Map();this.progressTimes=new Map();}
 async settings(){if(this.options.settings)return contactSettings(this.options.settings);try{return contactSettings(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if(e.code==='ENOENT')return contactSettings();throw e;}}
 async policy(turn){const c=await this.settings();if(!c.enabled)throw new Error('联系人信息图尚未启用，请管理员配置contacts.local.json。');
  const project=this.context.projects.chatProjectMap[turn.chatId];
  const scope=c.scopes.find(s=>s.projectId===project&&project===turn.projectId&&s.chatIds.includes(turn.chatId)&&s.profiles.includes(turn.profile)&&(!s.senderIds||s.senderIds.includes(turn.senderId)));
  if(!scope||!turn.senderId||turn.chatType==='p2p')throw new Error('当前提问不在已配置的联系人查询范围内。');return scope;}
 async catalog(turn){try{await this.policy(turn);return {enabled:true,identity:'bot',pending:await this.pending(turn),rule:'只查询机器人获准的通讯录；工号是字符串，保留前导零。不能操控桌面或借用部署者个人账号。'};}catch{return {enabled:false,pending:[]};}}
 async pending(turn){const s=await this.context.store.read();return (s.conversations??[]).filter(t=>t.status==='sent'&&t.chatId===turn.chatId&&t.senderId===turn.senderId&&t.profile===turn.profile&&t.projectId===turn.projectId
  &&(turn.questionId?t.questionId===turn.questionId:t.questionId==null)&&t.outcome?.contactCandidates?.length).slice(-1).map(t=>({query:t.outcome.contactQuery,candidates:t.outcome.contactCandidates}));}
 async request(route,params,turn){for(let attempt=0;;attempt++){try{if(typeof this.context.feishu.contactRequest!=='function')throw new Error();return await this.context.feishu.contactRequest(route,{user_id_type:'open_id',department_id_type:'open_department_id',...params},{profile:turn.profile});}catch(error){
   const raw=String(error?.message??'');let detail;try{detail=JSON.parse(raw.slice(raw.indexOf('{')))?.error;}catch{}
   const code=String(error?.code??detail?.code??detail?.type??'unclassified').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);
   const stage=route.endsWith('/scopes')?'scope':route.includes('/departments/')?'departments':route.includes('find_by_department')?'members':'person';
   const transient=['EAGAIN','ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH'].includes(code)||/HTTP\s*(?:429|50[0234])|rate.limit|too many requests/i.test(raw);
   if(transient&&attempt<2)continue;
   console.error('[contacts] request unavailable',JSON.stringify({stage,code}));throw new Error(`CONTACT_ACCESS：通讯录读取失败（${stage}/${code}），请管理员核对该机器人接口权限、数据范围或连接；未切换个人账号，也未发送资料图。`);
  }}}
 async pages(route,params,turn,visit){let token='';const seen=new Set();do{const d=await this.request(route,{...params,page_size:50,...(token?{page_token:token}:{})},turn);await visit(d);if(!d.has_more)break;if(typeof d.page_token!=='string'||!d.page_token||seen.has(d.page_token))throw new Error('CONTACT_PAGINATION：通讯录分页不完整，不能确认唯一人员。');token=d.page_token;seen.add(token);}while(true);}
 async report(turn,stage,values={}) {
  const now=Date.now(),previous=this.progressTimes.get(turn.id);
  if(previous?.stage===stage&&now-previous.at<(this.options.progressIntervalMs??3000))return;
  this.progressTimes.set(turn.id,{stage,at:now});
  if(this.progressTimes.size>1000)this.progressTimes.delete(this.progressTimes.keys().next().value);
  const progress={stage,updatedAt:new Date(now).toISOString()};
  for(const key of ['completedDepartments','totalDepartments','memberCount','pagesRead','completedPeople','totalPeople'])if(Number.isSafeInteger(values[key])&&values[key]>=0)progress[key]=values[key];
  try{await this.options.onProgress?.(turn,progress);if(typeof this.context.store?.transact==='function')await this.context.store.transact(s=>{const t=s.conversations?.find(t=>t.id===turn.id);if(t&&['queued','thinking','decided','ready'].includes(t.status))t.contactProgress=progress;});}catch{console.error('[contacts] progress recording unavailable');}
 }
 async users(turn,force=false){const ids=new Set(),departments=new Set(),users=new Map(),groupIds=new Set();let groups=false;
  await this.report(turn,'authorizing');
  await this.pages('/open-apis/contact/v3/scopes',{},turn,async d=>{for(const id of d.user_ids??[])ids.add(id);for(const id of d.department_ids??[])departments.add(id);for(const id of d.group_ids??[])groupIds.add(id);groups ||= Boolean(d.group_ids?.length);});
  const scopeFingerprint=digest({ids:[...ids].sort(),departments:[...departments].sort(),groups:[...groupIds].sort(),
    permissions:((await this.request('/open-apis/application/v6/scopes',{},turn)).scopes??[]).map(s=>({scope_name:s.scope_name,scope_type:s.scope_type,grant_status:s.grant_status})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
  const fresh=(await this.settings()).indexFreshnessMs;
  if(!force){let cached;try{cached=await this.index.get(turn.profile,scopeFingerprint,fresh);}catch{}if(cached){Object.assign(cached.users,{indexAsOf:cached.checkedAt,indexHit:true});await this.report(turn,'index_hit',{memberCount:cached.users.length});return cached.users;}}
  const flightKey=turn.profile+':'+scopeFingerprint;
  if(this.directoryFlights.has(flightKey)){const existing=this.directoryFlights.get(flightKey);existing.turns.set(turn.id,turn);if(existing.progress)await this.report(turn,existing.progress.stage,existing.progress.values);return existing.promise;}
  const flight={turns:new Map([[turn.id,turn]])};
  const emit=async(stage,values={})=>{flight.progress={stage,values};await Promise.all([...flight.turns.values()].map(t=>this.report(t,stage,values)));};
  flight.promise=(async()=>{
  await emit('directory_tree',{totalDepartments:departments.size});
  // Root access is verified by Feishu; root + descendants cover the approved full-company scope.
  if(groups){let root;try{root=(await this.request('/open-apis/contact/v3/departments/0',{},turn)).department;}catch{}
   if(String(root?.open_department_id??root?.department_id)!=='0')throw new Error('当前范围仅含用户组且无法核实全员根部门，暂不能确认完整人员；请管理员配置明确人员/部门或全员范围。');
   departments.clear();departments.add('0');}
  const roots=[...departments];for(const id of roots)await this.pages('/open-apis/contact/v3/departments/'+encodeURIComponent(id)+'/children',{fetch_child:true},turn,async d=>{for(const v of d.items??[])if(v.open_department_id)departments.add(v.open_department_id);await emit('directory_tree',{totalDepartments:departments.size});});
  let completedDepartments=0,pagesRead=0;
  const stats=()=>({completedDepartments,totalDepartments:departments.size,memberCount:users.size,pagesRead});
  await emit('directory_members',stats());
  await parallel([...departments],async department_id=>{await this.pages('/open-apis/contact/v3/users/find_by_department',{department_id},turn,async d=>{for(const u of d.items??[])if(u.open_id)users.set(u.open_id,u);pagesRead++;await emit('directory_members',stats());});completedDepartments++;await emit('directory_members',stats());});
  const direct=[...ids].filter(id=>!users.has(id));let completedPeople=0;
  if(direct.length)await emit('direct_members',{completedPeople,totalPeople:direct.length,memberCount:users.size});
  await parallel(direct,async id=>{const d=await this.request('/open-apis/contact/v3/users/'+encodeURIComponent(id),{},turn);if(d.user?.open_id)users.set(d.user.open_id,d.user);completedPeople++;await emit('direct_members',{completedPeople,totalPeople:direct.length,memberCount:users.size});});
  const result=[...users.values()].filter(u=>!u.status?.is_resigned);let checkedAt=Date.now();try{checkedAt=await this.index.put(turn.profile,scopeFingerprint,result);}catch{}Object.assign(result,{indexAsOf:checkedAt,indexHit:false});await emit('directory_ready',{memberCount:result.length});return result;
  })();this.directoryFlights.set(flightKey,flight);try{return await flight.promise;}finally{this.directoryFlights.delete(flightKey);}
 }
 async lookup(turn,q){const policy=await this.policy(turn);if(!q||!['name','employee_no'].includes(q.type)||typeof q.query!=='string'||!q.query.trim()||q.query.length>100||typeof q.candidateId!=='string')throw new Error('联系人查询参数无效。');
  if(q.candidateId){const pending=await this.pending(turn);if(!pending.some(p=>p.query?.query===q.query&&p.query?.type===q.type&&p.candidates.some(c=>c.id===q.candidateId)))throw new Error('请选择本问题已返回的候选人员，不能指定其他会话的候选。');}
  let users=await this.users(turn);const query=q.query.trim().normalize('NFKC').toLowerCase();
  const matching=list=>list.filter(u=>q.type==='employee_no'?clean(u.employee_no).normalize('NFKC')===q.query.trim().normalize('NFKC'):clean(u.name).normalize('NFKC').toLowerCase().includes(query));
  await this.report(turn,'matching');let matches=matching(users);if(!matches.length&&users.indexHit){users=await this.users(turn,true);matches=matching(users);}
  if(!matches.length){const missing=users.some(u=>!clean(q.type==='employee_no'?u.employee_no:u.name));return {notice:missing?(q.type==='employee_no'?'当前可读成员的工号字段未返回，暂时不能核对该工号；请管理员检查工号字段权限。':'当前可读成员的姓名字段未返回，暂时不能按姓名查找；请管理员检查成员基本信息权限。'):'在该机器人当前获准的通讯录范围内未找到匹配人员；不代表公司没有此人，请核对姓名/工号及通讯录数据范围。',contactQuery:q};}
  if(matches.length>1&&!q.candidateId){await this.report(turn,'candidates');const candidates=[];for(const previous of matches){const u=(await this.request('/open-apis/contact/v3/users/'+encodeURIComponent(previous.open_id),{},turn)).user;if(!u||u.status?.is_resigned||!matching([u]).length)throw new Error('候选资料已变化，请重新查询。');const f=contactFields(u);candidates.push({id:u.open_id,name:f.name,employeeNo:f.employeeNo,department:await this.departments(turn,f.departmentIds)});}return {notice:'找到多位匹配人员，请回复姓名及部门或选择下面对应序号，确认后才生成图片：\n'+candidates.map((u,i)=>`${i+1}. ${u.name} · ${u.department||'部门未返回'} · 工号 ${u.employeeNo||'未返回'}`).join('\n'),contactCandidates:candidates,contactQuery:{type:q.type,query:q.query}};}
  const user=q.candidateId?matches.find(u=>u.open_id===q.candidateId):matches[0];if(!user)throw new Error('原候选已变化，请重新查询确认。');
  await this.report(turn,'person');
  const fresh=(await this.request('/open-apis/contact/v3/users/'+encodeURIComponent(user.open_id),{},turn)).user;
  if(!fresh?.open_id||fresh.open_id!==user.open_id||fresh.status?.is_resigned)throw new Error('该人员当前资料无法核实，请重新查询。');
  if(q.type==='employee_no'&&clean(fresh.employee_no).normalize('NFKC')!==q.query.trim().normalize('NFKC')||q.type==='name'&&!clean(fresh.name).normalize('NFKC').toLowerCase().includes(query))throw new Error('候选资料已变化，请重新查询确认。');
  await this.report(turn,'organization');
  const fields=contactFields(fresh,policy.workEmailDomains),presentation=await this.presentation(turn,fields);
  const relative=path.join('contact-images',digest(bound(turn)).slice(0,32)+'.png'),target=path.join(this.context.config.dataDir,relative);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const directoryInfo=await lstat(path.dirname(target)),directory=await realpath(path.dirname(target));
  if(directoryInfo.isSymbolicLink()||path.dirname(directory)!==await realpath(this.context.config.dataDir))throw new Error('联系人图片目录无效。');
  for(const output of [target,target+'.json']){try{const info=await lstat(output);if(info.isSymbolicLink()||!info.isFile())throw new Error('联系人图片路径无效。');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const checkedAt=new Date().toISOString();await this.report(turn,'rendering');await this.render(target,{...fields,...presentation,checkedAt,directoryCheckedAt:new Date(users.indexAsOf).toISOString()});const body=await readFile(target);
  if(!body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('联系人图片生成失败，未发送。');
  const contactImage={relative,sha256:digest(body),bytes:body.length,binding:digest(bound(turn)),policyHash:digest(policy),personId:user.open_id,fieldsHash:digest(fields),presentationHash:digest(presentation),checkedAt,indexAsOf:users.indexAsOf,indexHit:users.indexHit};
  await writeFile(target+'.json',JSON.stringify(contactImage),{mode:0o600});await this.report(turn,'image_ready');return {notice:(turn.visibility==='requester'?'已生成联系人信息图，将通过机器人私聊发给你。':'已生成联系人信息图，将回复在本话题。')+'资料来自机器人当前获准的通讯录，不是飞书界面截图；未返回的字段标为未提供。',contactImage};
 }
 async departmentInfo(turn,ids){
  const paths=[],cache=new Map();
  for(const id of [...new Set(ids)]){
   const seen=new Set(),names=[];let current=id,complete=false;
   while(current){
    if(seen.has(current))break;seen.add(current);
    let department;
    try{if(!cache.has(current))cache.set(current,(await this.request('/open-apis/contact/v3/departments/'+encodeURIComponent(current),{},turn)).department);department=cache.get(current);}catch{break;}
    if(!department)break;
    const name=clean(department.name);if(current!=='0'&&!name)break;if(name)names.unshift(name);
    if(current==='0'){complete=true;break;}
    if(typeof department.parent_department_id!=='string'||!department.parent_department_id)break;
    current=department.parent_department_id;
   }
   if(names.length)paths.push(names.join(' → ')+(complete?'':'（上级路径未核实）'));
  }
  return [...new Set(paths)].join('\n');
 }
 async departments(turn,ids){return this.departmentInfo(turn,ids);}
 async presentation(turn,fields){const department=await this.departmentInfo(turn,fields.departmentIds);let leader='';
  if(fields.leaderId){try{leader=clean((await this.request('/open-apis/contact/v3/users/'+encodeURIComponent(fields.leaderId),{},turn)).user?.name);}catch{}}
  return {department,leader};
 }
 async validateImage(turn,item){await this.report(turn,'validating');const policy=await this.policy(turn);if(item.binding!==digest(bound(turn))||item.policyHash!==digest(policy))throw new Error('联系人图片所属范围已变化，未投递。');
  const expected=path.join('contact-images',digest(bound(turn)).slice(0,32)+'.png');if(item.relative!==expected)throw new Error('联系人图片路径无效。');
  const root=await realpath(path.join(this.context.config.dataDir,'contact-images')),file=path.join(this.context.config.dataDir,item.relative),info=await lstat(file),actual=await realpath(file);
  if((await lstat(path.join(this.context.config.dataDir,'contact-images'))).isSymbolicLink()||path.dirname(root)!==await realpath(this.context.config.dataDir))throw new Error('联系人图片目录无效。');
  if(info.isSymbolicLink()||!info.isFile()||path.dirname(actual)!==root)throw new Error('联系人图片路径无效。');const body=await readFile(actual);if(body.length!==item.bytes||digest(body)!==item.sha256)throw new Error('联系人图片校验失败。');
  const user=(await this.request('/open-apis/contact/v3/users/'+encodeURIComponent(item.personId),{},turn)).user;if(!user||user.status?.is_resigned||digest(contactFields(user,policy.workEmailDomains))!==item.fieldsHash)throw new Error('联系人资料或可见字段已变化，请重新查询后生成信息图。');
  if(item.presentationHash&&digest(await this.presentation(turn,contactFields(user,policy.workEmailDomains)))!==item.presentationHash)throw new Error('部门路径、上级或读取权限已变化，请重新生成联系人信息图。');return actual;
 }
}
async function parallel(items,visit){let index=0,failure;await Promise.allSettled(Array.from({length:Math.min(4,items.length)},async()=>{while(index<items.length&&!failure){const item=items[index++];try{await visit(item);}catch(error){failure=error;throw error;}}}));if(failure)throw failure;}
