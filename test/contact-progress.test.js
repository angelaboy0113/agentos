import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {ContactDirectory} from '../src/control-plane/contact-directory.js';
import {contactProgressText} from '../src/control-plane/contact-progress.js';
import {JsonStore} from '../src/shared/store.js';
const turn={id:'t',chatId:'g',projectId:'p',profile:'owner',senderId:'ou_asker'};
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'contact-progress-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new JsonStore(path.join(dir,'state.json'));await store.transact(s=>{s.conversations=[{...turn,status:'decided'},{...turn,id:'other',senderId:'ou_other',status:'decided'}];});
 const events=[];let memberRequests=0;
 const feishu={contactRequest:async(route,p)=>{
  if(route.endsWith('/scopes'))return {department_ids:['root'],has_more:false};
  if(route.endsWith('/children'))return {items:[{open_department_id:'child'}],has_more:false};
  if(route.endsWith('find_by_department')){memberRequests++;return p.department_id==='root'?{items:[{open_id:'ou_a',name:'SENSITIVE_NAME',employee_no:'001'}],has_more:!p.page_token,...(!p.page_token?{page_token:'next'}:{})}:{items:[{open_id:'ou_b',name:'SECOND_NAME',employee_no:'002'}],has_more:false};}
  throw new Error('unexpected route');
 }};
 const service=new ContactDirectory({config:{dataDir:dir},store,feishu},{settings:{enabled:true,scopes:[]},progressIntervalMs:0,onProgress:async(t,p)=>events.push({id:t.id,...p})});
 return {service,store,events,requests:()=>memberRequests};
}
test('measured scan counters account for all pages, complete departments and unique people; progress contains no personnel fields',async t=>{
 const x=await setup(t),users=await x.service.users(turn);assert.equal(users.length,2);assert.equal(x.requests(),3);
 const complete=x.events.filter(e=>e.stage==='directory_members').at(-1);assert.equal(complete.completedDepartments,2);assert.equal(complete.totalDepartments,2);assert.equal(complete.pagesRead,3);assert.equal(complete.memberCount,2);
 assert.doesNotMatch(JSON.stringify(x.events),/SENSITIVE_NAME|SECOND_NAME|ou_a|ou_b|employee_no/);
 assert.equal((await x.store.read()).conversations[0].contactProgress.stage,'directory_ready');
 x.events.length=0;await x.service.users(turn);assert.equal(x.requests(),3);assert.ok(x.events.some(e=>e.stage==='index_hit'&&e.memberCount===2));
});
test('concurrent same-scope lookups share the scan while recording progress for both original requests',async t=>{
 const x=await setup(t);await Promise.all([x.service.users(turn),x.service.users({...turn,id:'other',senderId:'ou_other'})]);assert.equal(x.requests(),3);
 for(const id of ['t','other'])assert.ok(x.events.some(e=>e.id===id&&e.stage==='directory_members'&&e.completedDepartments===2));
 assert.ok((await x.store.read()).conversations.every(t=>t.contactProgress.stage==='directory_ready'));
});
test('a progress storage failure never turns a successful directory read into a query failure',async t=>{
 const x=await setup(t);x.service.context.store.transact=async()=>{throw new Error('disk unavailable');};assert.equal((await x.service.users(turn)).length,2);
});
test('progress text uses known counters and last-advance age without guessing percentages or rendering arbitrary input',()=>{
 const text=contactProgressText({contactProgress:{stage:'directory_members',completedDepartments:3,totalDepartments:10,memberCount:90,pagesRead:4,updatedAt:'2026-10-19T02:00:00Z',name:'PRIVATE_NAME'}},Date.parse('2026-10-19T02:00:20Z'));
 assert.match(text,/3 \/ 10/);assert.match(text,/90/);assert.match(text,/20 秒前/);assert.doesNotMatch(text,/%|PRIVATE_NAME/);
 assert.match(contactProgressText({contactProgress:{stage:'<script>',updatedAt:''}}),/正在查询获准的通讯录/);
});
