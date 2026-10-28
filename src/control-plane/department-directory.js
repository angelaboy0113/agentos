import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const binding=t=>hash([t.id,t.chatId,t.senderId,t.profile,t.projectId,t.questionId??null,t.messageId]);
async function scopeIdentity(directory,turn){const value={user_ids:new Set(),department_ids:new Set(),group_ids:new Set()};await directory.pages('/open-apis/contact/v3/scopes',{},turn,d=>{for(const k of Object.keys(value))for(const id of d[k]??[])value[k].add(id);});const permissions=((await directory.request('/open-apis/application/v6/scopes',{},turn)).scopes??[]).map(v=>({scope_name:v.scope_name,scope_type:v.scope_type,grant_status:v.grant_status})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));return {...Object.fromEntries(Object.entries(value).map(([k,v])=>[k,[...v].sort()])),applicationScopes:permissions};}
// All reads go through the existing bot identity, policy and paginated contact adapter.
const normalized=v=>String(v??'').normalize('NFKC').trim().toLowerCase();
const parts=v=>normalized(v).split(/\s*(?:[-—–]+|[→>/])\s*/).filter(Boolean);
const idOf=d=>typeof d?.open_department_id==='string'?d.open_department_id:null;
export async function lookupDepartment(directory,turn,q){
 const policy=await directory.policy(turn);
 if(!q||q.type!=='department'||typeof q.query!=='string'||!q.query.trim()||typeof q.candidateId!=='string')throw new Error('部门查询参数无效。');
 if(q.candidateId){const pending=await directory.pending(turn);if(!pending.some(p=>p.query?.type==='department'&&p.query.query===q.query&&p.candidates.some(c=>c.id===q.candidateId)))throw new Error('请选择本问题已返回的候选部门，不能使用其它问题的候选。');}
 await directory.report(turn,'department_tree');
 const scope=await scopeIdentity(directory,turn),roots=new Set(scope.department_ids),groups=scope.group_ids.length>0;
 if(groups){const root=(await directory.request('/open-apis/contact/v3/departments/0',{},turn)).department;if(String(root?.open_department_id??root?.department_id)!=='0')throw new Error('无法核实用户组对应的完整部门范围，不能将可见成员数当作部门总人数。');roots.clear();roots.add('0');}
 if(!roots.size)return {notice:'机器人当前通讯录范围没有可核实的部门授权，无法统计完整部门人数；不能将个人可读范围当作部门全员。请管理员核对部门数据范围。',contactQuery:q};
 const nodes=new Map();
 const put=d=>{const id=idOf(d);if(!id)return;const old=nodes.get(id);if(old&&old.parent_department_id&&d.parent_department_id&&old.parent_department_id!==d.parent_department_id)throw new Error('读取期间组织归属发生变化，请重新查询；未发布混合组织结构的人数。');nodes.set(id,{...old,...d});};
 for(const id of roots){const root=(await directory.request('/open-apis/contact/v3/departments/'+encodeURIComponent(id),{},turn)).department;if(!root)throw new Error('授权部门详情未返回，不能确认部门范围。');put({...root,open_department_id:id});
  await directory.pages('/open-apis/contact/v3/departments/'+encodeURIComponent(id)+'/children',{fetch_child:true},turn,d=>{for(const item of d.items??[])put(item);return directory.report(turn,'department_tree',{totalDepartments:nodes.size});});}
 const pathFor=id=>{const seen=new Set(),names=[];let current=id;while(current&&nodes.has(current)){if(seen.has(current))throw new Error('部门组织路径存在循环，无法确认统计范围。');seen.add(current);const d=nodes.get(current);if(d.name)names.unshift(d.name);if(current==='0')break;current=d.parent_department_id;}return names;};
 const query=normalized(q.query),queryParts=parts(q.query);
 let matches=[...nodes].filter(([,d])=>normalized(d.name)===query);
 if(!matches.length)matches=[...nodes].filter(([id])=>{const path=parts(pathFor(id).join('→'));return queryParts.length<=path.length&&queryParts.every((v,i)=>v===path[path.length-queryParts.length+i]);});
 if(!matches.length)return {notice:'当前机器人获准的部门目录中没有匹配到该名称或组织路径，请补充完整部门路径；不代表公司不存在该部门。',contactQuery:q};
 if(matches.length>1&&!q.candidateId){await directory.report(turn,'department_candidates');const candidates=matches.map(([id,d])=>({id,name:d.name,department:pathFor(id).join(' → '),employeeNo:''}));return {notice:'匹配到多个同名部门，请回复对应序号或完整组织路径后再统计：\n'+candidates.map((c,i)=>`${i+1}. ${c.department}`).join('\n'),contactCandidates:candidates,contactQuery:{type:'department',query:q.query}};}
 const selected=q.candidateId?matches.find(([id])=>id===q.candidateId):matches[0];if(!selected)throw new Error('原候选部门已变化，请重新查询。');
 const [departmentId,department]=selected;
 const descendants=new Map([[departmentId,department]]);
 await directory.pages('/open-apis/contact/v3/departments/'+encodeURIComponent(departmentId)+'/children',{fetch_child:true},turn,d=>{for(const item of d.items??[]){const id=idOf(item);if(id)descendants.set(id,item);}});
 const all=new Set(),direct=new Set(),departmentCounts=[];let completedDepartments=0,pagesRead=0;
 const readStartedAt=new Date().toISOString();
 for(const [id,node] of descendants){const members=new Set();await directory.pages('/open-apis/contact/v3/users/find_by_department',{department_id:id},turn,d=>{for(const u of d.items??[]){if(!u.open_id)throw new Error('成员唯一标识未返回，不能确认去重人数。');if(u.status?.is_resigned)continue;members.add(u.open_id);all.add(u.open_id);if(id===departmentId)direct.add(u.open_id);}pagesRead++;});departmentCounts.push({id,name:node.name??'',directCount:members.size});completedDepartments++;await directory.report(turn,'department_count',{completedDepartments,totalDepartments:descendants.size,memberCount:all.size,pagesRead});}
 // Recheck current authorization before releasing any result. It must equal the read's scope.
 if(hash(await scopeIdentity(directory,turn))!==hash(scope))throw new Error('查询期间通讯录授权范围发生变化，请重新查询，未发布旧范围人数。');
 if(hash(await directory.policy(turn))!==hash(policy))throw new Error('查询期间联系人配置已变化，请重新查询。');
 const current=(await directory.request('/open-apis/contact/v3/departments/'+encodeURIComponent(departmentId),{},turn)).department;
 if(!current||current.name!==department.name||current.parent_department_id!==department.parent_department_id)throw new Error('查询期间部门名称或组织归属发生变化，请重新查询。');
 const checkedAt=new Date().toISOString(),departmentPath=pathFor(departmentId).join(' → ');
 return {notice:`部门：${departmentPath}\n直属人数：${direct.size} 人\n包含下级部门：${all.size} 人（按成员唯一标识去重）\n统计部门数：${descendants.size}\n口径：机器人获准读取范围内、未标记离职的成员；兼属多个部门只计一次，冻结或未激活成员如未离职也纳入。不能将权限外成员视为0人。\n读取窗口：${readStartedAt} 至 ${checkedAt}（UTC），分别读取，不是同一时点的事务快照。`,contactQuery:q,departmentSummary:{departmentId,departmentPath,directCount:direct.size,totalCount:all.size,departmentCounts,readStartedAt,checkedAt,scope:'approved-bot-directory',authorization:{binding:binding(turn),policyHash:hash(policy),scopeHash:hash(scope),name:department.name,parentId:department.parent_department_id??null}}};
}

export async function validateDepartmentSummary(directory,turn,item){
 const policy=await directory.policy(turn),proof=item?.authorization;
 if(!proof||proof.binding!==binding(turn)||proof.policyHash!==hash(policy))throw new Error('部门统计所属问题或读取配置已变化，未投递旧结果。');
 if(hash(await scopeIdentity(directory,turn))!==proof.scopeHash)throw new Error('部门统计的通讯录范围已变化，请重新查询后投递。');
 const d=(await directory.request('/open-apis/contact/v3/departments/'+encodeURIComponent(item.departmentId),{},turn)).department;
 if(!d||d.name!==proof.name||(d.parent_department_id??null)!==proof.parentId)throw new Error('部门统计的组织信息已变化，请重新查询。');
}
