import test from 'node:test';
import assert from 'node:assert/strict';
import {adminTaskMetrics, maintenanceTest} from '../src/control-plane/admin-metrics.js';
import {adminOverview,adminRecords} from '../src/control-plane/admin-view.js';
const now=Date.parse('2026-11-12T12:00:00Z'), at=ms=>new Date(now+ms).toISOString();
const job=(id,extra={})=>({id,createdAt:at(-120000),updatedAt:at(-60000),status:'completed',result:{outcome:'ready',timing:{totalMs:1}},...extra});

test('overview aggregates all retained jobs before any record pagination and never counts intake twice',()=>{
 const jobs=Array.from({length:180},(_,i)=>job('j'+i));
 const conversations=jobs.map(j=>({id:'c'+j.id,createdAt:j.createdAt,completedAt:j.updatedAt,status:'sent',decision:{action:'create_task',jobId:j.id},timing:{totalMs:20}}));
 const s={jobs,conversations},before=JSON.stringify(s),v=adminOverview(s,{},now);
 assert.equal(v.counts.completed24h,180);assert.equal(v.counts.intake24h,180);assert.equal(v.counts.total,180);assert.equal(v.performance.medianMs,60000);assert.equal(v.recent.length,8);assert.equal(adminRecords(s).length,100);assert.equal(JSON.stringify(s),before);
});
test('partial, blocked, failed, cancellation, unknown and waiting results remain distinct',()=>{
 const s={jobs:[job('ok'),job('partial',{result:{outcome:'partial'}}),job('blocked',{status:'blocked'}),job('failed',{status:'failed'}),job('cancelled',{status:'cancelled'}),job('legacy',{result:{}}),job('wait',{result:{outcome:'needs_clarification'}}),job('approval',{status:'awaiting_approval'})]};
 const {counts:c,performance:p}=adminTaskMetrics(s,now);
 assert.equal(c.completed24h,1);assert.equal(c.partial24h,1);assert.equal(c.blocked24h,1);assert.equal(c.failed24h,1);assert.equal(c.cancelled24h,1);assert.equal(c.unverified24h,1);assert.equal(c.waiting,2);assert.equal(c.finished24h,5);assert.equal(p.successRate,20);assert.equal(p.sampleCount,5);
 assert.equal(adminRecords(s,{status:'partial'})[0].id,'partial');assert.equal(adminRecords(s,{status:'awaiting_clarification'})[0].id,'wait');assert.equal(adminRecords(s).find(x=>x.id==='partial').status,'completed');
});
test('rolling window uses actual terminal event, not creation or later housekeeping update',()=>{
 const s={jobs:[job('long',{createdAt:at(-2*86400000),events:[{type:'completed',at:at(-1000)}]}),job('old',{createdAt:at(-2*86400000),updatedAt:at(-1000),events:[{type:'completed',at:at(-86400000-1)}]}),job('future',{updatedAt:at(1)}),job('invalid',{updatedAt:'bad'}),job('boundary',{updatedAt:at(-86400000)}),job('now',{updatedAt:at(0)})]};
 const v=adminTaskMetrics(s,now);assert.equal(v.counts.completed24h,2);assert.equal(v.metricPolicy.timeBasis,'terminal_event');assert.equal(v.performance.sampleCount,2);
});
test('latest workflow job per question card is counted once with bot and chat isolation',()=>{
 const jobs=[job('a',{questionId:'q',originProfile:'a',chatId:'chat',createdAt:at(-5000)}),job('b',{questionId:'q',originProfile:'a',chatId:'chat',createdAt:at(-4000),updatedAt:at(-1000),result:{outcome:'partial'}}),job('c',{questionId:'q',originProfile:'b',chatId:'chat'}),job('d',{questionId:'q',originProfile:'a',chatId:'other'})];
 const v=adminTaskMetrics({jobs},now);assert.equal(v.counts.total,3);assert.equal(v.counts.completed24h,2);assert.equal(v.counts.partial24h,1);
 jobs.push(job('new',{questionId:'q',originProfile:'a',chatId:'chat',createdAt:at(-500),status:'running'}));const active=adminTaskMetrics({jobs},now);assert.equal(active.counts.active,1);assert.equal(active.counts.partial24h,0);
});
test('explicit maintenance marks exclude test results by default, can be included without altering state',()=>{
 const jobs=[job('test',{originalQuestion:'【AgentOS维护自测 X7，完成后撤回】 PRD查询'}),job('metadata',{isMaintenanceTest:true}),job('normal',{originalQuestion:'请解释维护自测功能'})];
 const s={jobs},a=adminTaskMetrics(s,now),b=adminTaskMetrics(s,now,{includeMaintenance:true});assert.equal(a.counts.completed24h,1);assert.equal(a.counts.maintenance24h,2);assert.equal(b.counts.completed24h,3);assert.equal(b.metricPolicy.includeMaintenance,true);
 assert.equal(maintenanceTest({originalQuestion:'请看看测试环境的业务'}),false);
});
test('duration spans original question and uses terminal event rather than last model turn',()=>{
 const s={questions:{q:{createdAt:at(-600000)}},jobs:[job('j',{questionId:'q',events:[{type:'completed',at:at(-60000)}],updatedAt:at(-1),result:{outcome:'ready',timing:{totalMs:1}}})]};
 assert.equal(adminTaskMetrics(s,now).performance.medianMs,540000);assert.equal(adminRecords(s)[0].durationMs,540000);
});
test('standard median averages middle values and empty samples are not zero-success claims',()=>{
 const s={jobs:[job('a',{createdAt:at(-2000),updatedAt:at(-1000)}),job('b',{createdAt:at(-4000),updatedAt:at(-1000)})]};assert.equal(adminTaskMetrics(s,now).performance.medianMs,2000);const e=adminTaskMetrics({},now);assert.equal(e.performance.medianMs,null);assert.equal(e.performance.successRate,null);
});
test('ordinary reply and duplicate intake records stay separate from task success',()=>{
 const turn=(id,action)=>({id,profile:'bot',chatId:'chat',messageId:id,createdAt:at(-5000),completedAt:at(-1000),status:'sent',decision:{action}});
 const s={conversations:[turn('a','reply'),turn('b','create_task'),turn('b','create_task'),turn('t','reply'),turn('future','reply')]};s.conversations[3].content='【维护自测】回复';s.conversations[4].completedAt=at(1);const v=adminTaskMetrics(s,now);assert.equal(v.counts.completed24h,0);assert.equal(v.counts.replies24h,1);assert.equal(v.counts.intake24h,1);assert.equal(v.performance.medianMs,null);
});
