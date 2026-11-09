import test from 'node:test';import assert from 'node:assert/strict';
import {adminUsage,AdminUsageDirectory} from '../src/control-plane/admin-usage.js';
const turn=(id,extra={})=>({id,messageId:'m-'+id,profile:'a',chatId:'g',senderId:'u',createdAt:'2026-11-06T16:00:00Z',content:'查询销售数据',status:'sent',...extra});
test('usage counts messages once, not associated jobs, with profiles and days isolated',()=>{
 const t=turn('1'),s={conversations:[t,{...t},turn('2',{profile:'b'}),turn('3',{createdAt:'2026-11-06T15:59:59Z'})],jobs:[{id:'j',sourceMessageId:t.messageId,originProfile:'a'}]};
 const u=adminUsage(s,{start:'2026-11-07',end:'2026-11-07'});assert.equal(u.summary.messages,2);assert.equal(u.excluded.duplicate,1);assert.equal(u.records.find(r=>r.id==='1').recordId,'j');assert.equal(adminUsage(s,{profile:'b'}).summary.messages,1);
});
test('usage excludes private sensitive control environment and social without discarding genuine business',()=>{
 const s={conversations:[turn('1'),turn('2',{chatType:'p2p'}),turn('3',{visibility:'private'}),turn('4',{content:'密码: sensitive-value'}),turn('5',{content:'prd环境'}),turn('6',{content:'哈哈'}),turn('7',{content:'取消任务'})]};
 const u=adminUsage(s);assert.equal(u.summary.messages,1);assert.equal(adminUsage(s,{scope:'all'}).summary.messages,4);assert.ok(!JSON.stringify(u).includes('sensitive-value'));
});
test('names merge only for presentation, trusted identities and administrator exclusion preserve scope',()=>{
 const s={conversations:[turn('1'),turn('2',{profile:'b',senderId:'v'}),turn('3',{senderId:'owner'})]},names=new Map([[JSON.stringify(['a','g','u']),'张三'],[JSON.stringify(['b','g','v']),'张三']]),projects={ownerOpenIdsByProfile:{a:['owner']}};
 assert.equal(adminUsage(s,{}, {names,projects}).summary.people,1);assert.equal(adminUsage(s,{grouping:'identity'},{names,projects}).summary.people,2);assert.equal(adminUsage(s,{excludeAdmin:'false'},{names,projects}).summary.messages,3);
});
test('equal ranking ties, per person pagination and deterministic record ordering',()=>{
 const s={conversations:Array.from({length:121},(_,i)=>turn(String(i),{senderId:i<60?'u':i<120?'v':'w',parentId:i%2?'root':null}))};const u=adminUsage(s);assert.deepEqual(u.ranking.map(p=>p.rank),[1,1,3]);const person=u.ranking[0].key;const page=adminUsage(s,{person,page:'2'});assert.equal(page.records.length,10);assert.equal(page.pagination.total,60);assert.equal(page.summary.messages,121);
});
test('invalid dates timezone and reversed range are rejected and boundary timezone is explicit',()=>{
 for(const q of [{start:'2026-02-30'},{start:'2026-11-08',end:'2026-11-07'},{timeZone:'bad'}])assert.throws(()=>adminUsage({},q));
 assert.equal(adminUsage({conversations:[turn('1')]},{start:'2026-11-07',timeZone:'UTC'}).summary.messages,0);
});
test('same message id in another profile/group stays separate and missing sender is not fabricated',()=>{
 const t=turn('1');const u=adminUsage({conversations:[t,{...t,chatId:'g2'},{...t,profile:'b'},turn('2',{senderId:''})]});assert.equal(u.summary.messages,3);assert.equal(u.excluded.invalid,1);
});
test('member directory cache deduplicates concurrent refresh and preserves identity per profile',async()=>{
 let n=0;const d=new AdminUsageDirectory({replyAddressing:{members:async(g,p)=>{n++;return new Map([['u',p+' name']]);}}}),s={conversations:[turn('1'),turn('2',{profile:'b'}),turn('3',{chatType:'p2p'})]};
 const [a,b]=await Promise.all([d.names(s),d.names(s)]);assert.equal(n,2);assert.deepEqual(a,b);assert.equal(a.get(JSON.stringify(['a','g','u'])),'a name');await d.names(s);assert.equal(n,2);
});
test('failed name permission does not hide stored questions or invent names',async()=>{
 const d=new AdminUsageDirectory({replyAddressing:{members:async()=>{throw Error('denied')}}}),s={conversations:[turn('1')]};const u=adminUsage(s,{}, {names:await d.names(s)});assert.equal(u.summary.messages,1);assert.equal(u.ranking[0].name,'姓名暂不可用');
});

test('private question object storage is excluded even if old turn lacks visibility',()=>{const t=turn('1',{questionId:'q'});assert.equal(adminUsage({conversations:[t],questions:{q:{id:'q',visibility:'private'}}}).summary.messages,0);});
