import test from 'node:test';import assert from 'node:assert/strict';
import {adminCheckins,adminUsage,AdminUsageDirectory} from '../src/control-plane/admin-usage.js';
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

test('check-in rankings count Beijing signing days, preserve yesterday until midnight and keep same names separate', () => {
 const row = (day, senderId='ou_member', profile='ltx') => ({
  day,senderId,profile,chatId:'oc_group',createdAt:day+'T01:00:00Z',points:1,
 });
 const checkins = {
  a:row('2026-11-19'),b:row('2026-11-20'),c:row('2026-11-22'),d:row('2026-11-23'),
  alias:row('2026-11-23','ou_alias','tpm'),sameName:row('2026-11-24','ou_other'),
  missed:row('2026-11-22','ou_missed'),private:{...row('2026-11-24','ou_preview'),preview:true},
 };
 const names = new Map([
  [JSON.stringify(['ltx','oc_group','ou_member']),'同名成员'],
  [JSON.stringify(['ltx','oc_group','ou_other']),'同名成员'],
 ]);
 const projects = {humanIdentities:{verified:{ltx:'ou_member',tpm:'ou_alias'}}};
 const result = adminCheckins({checkins},{},{projects,names,now:Date.parse('2026-11-23T16:00:00Z')});
 assert.equal(result.day,'2026-11-24');
 assert.deepEqual(result.summary,{signedPeople:1,signClicks:0});
 assert.equal(result.totalRanking.length,3);
 assert.deepEqual(result.totalRanking[0],{key:'human:verified',name:'同名成员',total:4,current:2,longest:2,lastDay:'2026-11-23',rank:1});
 assert.deepEqual(result.totalRanking.slice(1).map(x=>x.rank),[2,2]);
 assert.equal(result.streakRanking.length,2);
 assert.equal(result.records.length,1);
 assert.equal(result.records[0].name,'同名成员');
 const tomorrow = adminCheckins({checkins},{day:'2026-11-23',person:'human:verified'},{projects,names,now:Date.parse('2026-11-24T16:00:00Z')});
 assert.equal(tomorrow.totalRanking[0].current,0);
 assert.equal(tomorrow.totalRanking[0].longest,2);
 assert.equal(tomorrow.summary.signedPeople,1);
 assert.throws(()=>adminCheckins({checkins},{day:'2026-02-30'}),/Invalid check-in date/);
});

test('check-in click review paginates retained formal clicks independently of awarded points', () => {
 const event = {day:'2026-11-24',createdAt:'2026-11-24T04:00:00Z',senderId:'ou_member',profile:'ltx',chatId:'oc_group'};
 const checkinReceipts = Object.fromEntries(Array.from({length:51},(_,i)=>[i,{...event,action:'daily_checkin',sent:true,text:'private receipt'}]));
 checkinReceipts.preview={...event,action:'daily_checkin',preview:true};
 checkinReceipts.query={...event,action:'my_checkin_points'};
 const options = {now:Date.parse('2026-11-24T04:30:00Z')};
 const result=adminCheckins({checkins:{first:event},checkinReceipts},{type:'clicks',page:'99'},options);
 assert.deepEqual(result.summary,{signedPeople:1,signClicks:51});
 assert.deepEqual(result.pagination,{page:2,pages:2,total:52});
 assert.equal(result.records.at(-1).action,'查我的积分');
 assert.equal(result.records.at(-1).notified,false);
 assert.ok(!JSON.stringify(result).includes('private receipt'));
 assert.deepEqual(adminCheckins({checkins:{first:event},checkinReceipts},{person:'other'},options).records,[]);
});
