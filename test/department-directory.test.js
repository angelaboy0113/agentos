import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {ContactDirectory} from '../src/control-plane/contact-directory.js';
import {decisionTurn,validateDecision,conversationFailure} from '../src/control-plane/codex-conversation.js';
const actor={id:'turn',chatId:'g',profile:'owner',senderId:'ou_sender',projectId:'p',messageId:'m',questionId:'q'};
const cfg={enabled:true,scopes:[{projectId:'p',chatIds:['g'],profiles:['owner']}]};
const node=(id,name,parent)=>({open_department_id:id,name,parent_department_id:parent});
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'department-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const nodes=[node('0','集团',null),node('sales','销售中心','0'),node('snack','零食折扣发展部','sales'),node('channel','渠道运营部','snack'),node('child','渠道一组','channel'),node('other','其他中心','0'),node('same','渠道运营部','other')];
 const calls=[],progress=[];let pending=[],scope={department_ids:['0']},grants=['directory'];
 const context={config:{dataDir:dir},projects:{chatProjectMap:{g:'p'}},store:{read:async()=>({conversations:pending})},feishu:{contactRequest:async(route,args)=>{calls.push({route,args});
  if(route==='/open-apis/application/v6/scopes')return {scopes:grants.map(scope_name=>({scope_name,grant_status:1}))};
  if(route.endsWith('/scopes'))return {...scope,has_more:false};
  if(route.endsWith('/children')){const id=route.split('/').at(-2);return {items:id==='0'?nodes.slice(1):id==='channel'?[nodes[4]]:[],has_more:false};}
  if(route.endsWith('/find_by_department')){if(args.department_id==='channel')return args.page_token?{items:[{open_id:'a'},{open_id:'r',status:{is_resigned:true}}],has_more:false}:{items:[{open_id:'a'},{open_id:'b'}],has_more:true,page_token:'next'};return {items:args.department_id==='child'?[{open_id:'b'},{open_id:'c'}]:[],has_more:false};}
  return {department:nodes.find(n=>n.open_department_id===route.split('/').at(-1))};}}};
 const service=new ContactDirectory(context,{settings:cfg,onProgress:async(_,p)=>progress.push(p),progressIntervalMs:0});return {context,service,calls,progress,setPending:x=>pending=x,setScope:x=>scope=x,setGrants:x=>grants=x,nodes};}
const query={type:'department',query:'零食折扣发展部--渠道运营部',candidateId:''};
test('department paths resolve, pagination includes all members and descendants deduplicate live counts',async t=>{const f=await fixture(t);const r=await f.service.lookup(actor,query);assert.equal(r.departmentSummary.directCount,2);assert.equal(r.departmentSummary.totalCount,3);assert.equal(r.departmentSummary.departmentCounts.length,2);assert.match(r.notice,/集团 → 销售中心 → 零食折扣发展部 → 渠道运营部/);assert.match(r.notice,/未标记离职/);assert.ok(f.progress.some(p=>p.stage==='department_count'&&p.memberCount===3));assert.equal(r.contactImage,undefined);assert.ok(f.calls.filter(c=>c.route.endsWith('/find_by_department')).every(c=>['channel','child'].includes(c.args.department_id)));await f.service.validateDepartmentSummary(actor,r.departmentSummary);});
test('ambiguous departments require candidates bound to requester and original question',async t=>{const f=await fixture(t),q={...query,query:'渠道运营部'};const r=await f.service.lookup(actor,q);assert.equal(r.contactCandidates.length,2);assert.equal(r.departmentSummary,undefined);assert.ok(!f.calls.some(c=>c.route.endsWith('/find_by_department')));f.setPending([{...actor,status:'sent',outcome:r}]);assert.equal((await f.service.lookup(actor,{...q,candidateId:'channel'})).departmentSummary.totalCount,3);await assert.rejects(f.service.lookup({...actor,senderId:'other'},{...q,candidateId:'channel'}),/候选部门/);});
test('unmatched or individual-only scope is not reported as zero company employees',async t=>{const f=await fixture(t);const r=await f.service.lookup(actor,{...query,query:'不存在的部门'});assert.equal(r.departmentSummary,undefined);assert.match(r.notice,/不代表公司不存在/);f.setScope({user_ids:['a']});assert.match((await f.service.lookup(actor,query)).notice,/无法统计完整部门人数/);});
test('interrupted pagination, missing identifiers and organization cycles never publish partial totals',async t=>{const f=await fixture(t),original=f.context.feishu.contactRequest;f.context.feishu.contactRequest=async(route,args)=>{if(route.endsWith('/find_by_department')&&args.page_token)throw new Error('network failure');return original(route,args);};await assert.rejects(f.service.lookup(actor,query),/CONTACT_ACCESS/);f.context.feishu.contactRequest=async(route,args)=>route.endsWith('/find_by_department')?{items:[{name:'no identifier'}]}:original(route,args);await assert.rejects(f.service.lookup(actor,query),/唯一标识/);f.context.feishu.contactRequest=original;f.nodes.find(n=>n.open_department_id==='snack').parent_department_id='channel';await assert.rejects(f.service.lookup(actor,query),/循环/);});
test('changed policy, actor, scope or renamed department revokes pending private count results',async t=>{const f=await fixture(t),r=await f.service.lookup(actor,query);await assert.rejects(f.service.validateDepartmentSummary({...actor,senderId:'other'},r.departmentSummary),/所属问题/);f.setScope({department_ids:['other']});await assert.rejects(f.service.validateDepartmentSummary(actor,r.departmentSummary),/范围已变化/);f.setScope({department_ids:['0']});f.setGrants([]);await assert.rejects(f.service.validateDepartmentSummary(actor,r.departmentSummary),/范围已变化/);f.setGrants(['directory']);f.nodes.find(n=>n.open_department_id==='channel').name='新名称';await assert.rejects(f.service.validateDepartmentSummary(actor,r.departmentSummary),/组织信息已变化/);f.service.options.settings={...cfg,enabled:false};await assert.rejects(f.service.validateDepartmentSummary(actor,r.departmentSummary),/尚未启用/);});
const decision={reply:'正在核对部门人数',action:'lookup_contact',intent:'none',instruction:'',jobId:'',projectId:'',attachmentIds:[],requiresSourceInspection:false,environmentQuery:null,environmentSetup:null,knowledgeMatch:null,contactLookup:query};
test('typed department decisions work without task permissions and recover transient upstream routing errors',async()=>{assert.equal(validateDecision(decision).contactLookup.type,'department');assert.throws(()=>validateDecision({...decision,requiresSourceInspection:true}));let calls=0;const events=[];const app={turn:async()=>{if(++calls<3)throw new Error('workspace routing discovery failed');return {text:JSON.stringify(decision),timing:{totalMs:1}};}};const r=await decisionTurn(app,{}, {waitForRoutingRetry:async()=>{},onEvent:(kind,p)=>events.push(p)});assert.equal(r.timing.routingRetries,2);assert.equal(events[0].reason,'workspace_routing');assert.match(conversationFailure(new Error('workspace routing discovery failed')),/尚未执行通讯录/);});
test('routing recovery is abortable and does not retry permanent errors',async()=>{let n=0;await assert.rejects(decisionTurn({turn:async()=>{n++;throw new Error('permission denied');}},{},{}),/permission denied/);assert.equal(n,1);const abort=new AbortController();await assert.rejects(decisionTurn({turn:async()=>{throw new Error('workspace routing discovery failed');}},{},{signal:abort.signal,waitForRoutingRetry:async()=>abort.abort()}),/Conversation stopped/);});

test('model routing recovery and measured department counts have accurate private progress text',async()=>{
 const {conversationCard}=await import('../src/control-plane/message-cards.js');const {contactProgressText}=await import('../src/control-plane/contact-progress.js');
 const card=conversationCard({status:'thinking',role:'owner_intake',connectionWillRetry:true,connectionRetryReason:'workspace_routing',createdAt:new Date().toISOString()});assert.match(JSON.stringify(card),/工作区路由暂时不可用/);
 assert.match(contactProgressText({contactProgress:{stage:'department_count',updatedAt:new Date().toISOString(),completedDepartments:2,totalDepartments:4,memberCount:7,pagesRead:3}}),/2 \/ 4.*7 人/);
});

test('only the exact explicit department command bypasses language interpretation',async()=>{const {departmentCommand}=await import('../src/control-plane/contact-commands.js');assert.equal(departmentCommand('帮我查部门人数'),null);assert.equal(departmentCommand('/部署 prod'),null);assert.equal(departmentCommand('/部门人数').action,'reply');assert.equal(validateDecision(departmentCommand('/部门人数 公司--部门')).contactLookup.query,'公司--部门');});

async function personFixture(t){
 const f=await fixture(t),base=f.context.feishu.contactRequest;
 const people=[{open_id:'a',name:'测试甲',employee_no:'0011782',job_title:'系统经理',department_ids:['channel']},{open_id:'b',name:'测试乙',employee_no:'0002',job_title:'储备岗',department_ids:['channel','child']},{open_id:'c',name:'测试丙',employee_no:'0003',job_title:'专员',department_ids:['child']}];
 f.service.users=async()=>Object.assign(people,{indexAsOf:Date.now(),indexHit:true});
 f.context.feishu.contactRequest=async(route,args)=>{
  if(route.includes('/users/')&&!route.endsWith('/find_by_department'))return {user:people.find(p=>p.open_id===route.split('/').at(-1))};
  const r=await base(route,args);if(route.endsWith('/find_by_department'))return {...r,items:r.items.map(p=>({...people.find(u=>u.open_id===p.open_id),...p}))};return r;
 };return {...f,people};
}
test('person department intent resolves current department ID and publishes all paginated names, numbers and roles, not a personal image',async t=>{
 const f=await personFixture(t),q={type:'department_of_employee_no',query:'0011782',candidateId:''};
 assert.equal(validateDecision({...decision,contactLookup:q}).contactLookup.type,q.type);
 const r=await f.service.lookup(actor,q);assert.equal(r.contactImage,undefined);assert.equal(r.departmentSummary.directCount,2);assert.equal(r.departmentSummary.totalCount,3);
 assert.match(r.notice,/测试甲.*0011782/);assert.match(r.notice,/测试乙.*0002.*储备岗/);assert.match(r.notice,/测试丙.*下级部门/);assert.equal(r.departmentSummary.members.length,3);assert.deepEqual(r.departmentSummary.directMemberIds,['a','b']);
 assert.ok(!JSON.stringify(r.departmentSummary).includes('mobile'));await f.service.validateDepartmentSummary(actor,r.departmentSummary);
 f.people[0].department_ids=['other'];await assert.rejects(f.service.validateDepartmentSummary(actor,r.departmentSummary),/所属部门已变化/);
});
test('person name ambiguities preserve the department intent and candidate binding',async t=>{
 const f=await personFixture(t);f.people[1].name='测试甲';const q={type:'department_of_name',query:'测试甲',candidateId:''};
 const r=await f.service.lookup(actor,q);assert.equal(r.contactCandidates.length,2);assert.equal(r.contactQuery.type,q.type);assert.match(r.notice,/查询其部门成员/);assert.equal(r.departmentSummary,undefined);
 f.setPending([{...actor,status:'sent',outcome:r}]);assert.equal((await f.service.lookup(actor,{...q,candidateId:'a'})).departmentSummary.directCount,2);
 await assert.rejects(f.service.lookup({...actor,senderId:'other'},{...q,candidateId:'a'}),/候选人员/);
});
test('multiple and missing person memberships require clarification instead of selecting first or treating absence as zero',async t=>{
 const f=await personFixture(t),q={type:'department_of_employee_no',query:'0011782',candidateId:''};
 f.people[0].department_ids=['channel','same'];let r=await f.service.lookup(actor,q);assert.match(r.notice,/多个部门/);assert.equal(r.departmentSummary,undefined);
 f.people[0].department_ids=[];r=await f.service.lookup(actor,q);assert.match(r.notice,/未返回其所属部门/);assert.equal(r.departmentSummary,undefined);
 f.people[0].department_ids=['not-authorized'];r=await f.service.lookup(actor,q);assert.equal(r.departmentSummary,undefined);assert.match(r.notice,/没有匹配/);
});
test('department roster escapes member text, preserves missing fields and rejects interrupted pages',async t=>{
 const f=await personFixture(t);f.people[1].name='<at user_id="all">';delete f.people[1].job_title;
 const r=await f.service.lookup(actor,query);assert.doesNotMatch(r.notice,/<at/);assert.match(r.notice,/岗位未提供/);assert.equal(r.departmentSummary.directCount,2);
 const base=f.context.feishu.contactRequest;f.context.feishu.contactRequest=async(route,args)=>{if(args.page_token)throw new Error('read failed');return base(route,args);};await assert.rejects(f.service.lookup(actor,query),/CONTACT_ACCESS/);
 const {departmentCommand}=await import('../src/control-plane/contact-commands.js');assert.equal(validateDecision(departmentCommand('/部门成员 公司--中心')).contactLookup.type,'department');
});

test('explicit same-department commands retain employee zeros and support names without a model',async()=>{
 const {departmentCommand}=await import('../src/control-plane/contact-commands.js');
 assert.deepEqual(validateDecision(departmentCommand('/同部门 00001234')).contactLookup,{type:'department_of_employee_no',query:'00001234',candidateId:''});
 assert.equal(validateDecision(departmentCommand('/同部门 姓名 测试甲')).contactLookup.type,'department_of_name');
 assert.equal(departmentCommand('/同部门').action,'reply');assert.equal(departmentCommand('同部门同事有哪些'),null);
});
