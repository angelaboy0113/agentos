import test from 'node:test';
import assert from 'node:assert/strict';
import {EditedMentionWatcher} from '../src/control-plane/edited-mentions.js';
const message={message_id:'m1',msg_type:'post',content:'original',sender:{id:'ou_user1',id_type:'open_id',sender_type:'user'},mentions:[],updated:false};
function fixture(){let rows=[structuredClone(message)],fail=false;const delivered=[],status=[];const watcher=new EditedMentionWatcher({config:{botOpenId:'ou_bot'}},['configured'],{}, {list:async()=>{if(fail)throw new Error('230027');return rows;},deliver:async e=>delivered.push(e),save:async s=>status.push(s)});return{watcher,delivered,status,set:r=>{rows=r;},fail:()=>{fail=true;}};}
test('edited late mention is recovered after baseline with original identity, thread and attachments type',async()=>{
 const f=fixture();await f.watcher.scan();const changed={...message,updated:true,content:'@bot question with image',mentions:[{id:{open_id:'ou_bot'},key:'@bot'}],thread_id:'omt_thread'};f.set([changed]);await f.watcher.scan();await f.watcher.scan();assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].sender_id,'ou_user1');assert.equal(f.delivered[0].thread_id,'omt_thread');assert.equal(f.delivered[0].message_type,'post');assert.equal(f.delivered[0].mentions[0].id,'ou_bot');
});
test('startup does not replay old edited mentions; no mention, bot, deleted or other bot never dispatch',async()=>{
 const f=fixture();f.set([{...message,updated:true,mentions:[{id:'ou_bot'}]}]);await f.watcher.scan();assert.equal(f.delivered.length,0);
 for(const changes of [{mentions:[]},{sender:{id:'ou_bot',sender_type:'app'}},{deleted:true},{mentions:[{id:'other'}]}]){f.set([{...message,updated:true,content:JSON.stringify(changes),mentions:[{id:'ou_bot'}],...changes}]);await f.watcher.scan();}assert.equal(f.delivered.length,0);
});
test('read failure is visible, does not dispatch or borrow user identity; failed delivery can retry',async()=>{
 const f=fixture();f.fail();await f.watcher.scan();assert.equal(f.status[0].failures.length,1);assert.equal(f.delivered.length,0);
 const g=fixture();await g.watcher.scan();g.set([{...message,updated:true,content:'new',mentions:[{id:'ou_bot'}]}]);let n=0;g.watcher.deliver=async()=>{if(++n===1)throw new Error('delivery');};await g.watcher.scan();await g.watcher.scan();assert.equal(n,2);
});

test('trusted app ID mentions are normalized for ingress; the other system cannot capture them',async()=>{
 const f=fixture();f.watcher.source.config.botAppId='cli_app';await f.watcher.scan();f.set([{...message,updated:true,mentions:[{id:'cli_app',key:'@_user_1'}]}]);await f.watcher.scan();assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].mentions[0].id,'ou_bot');
 const g=fixture();g.watcher.source.config.botAppId='cli_other';await g.watcher.scan();g.set([{...message,updated:true,mentions:[{id:'cli_app'}]}]);await g.watcher.scan();assert.equal(g.delivered.length,0);
});
test('checkpoint survives restart and catches an edit made during downtime without replaying processed text',async()=>{
 const f=fixture();await f.watcher.scan();const checkpoint=f.status.at(-1);const out=[];
 const config={botOpenId:'ou_bot'};const changed={...message,updated:true,content:'edited while offline',mentions:[{id:'ou_bot'}]};let saved;
 const make=()=>new EditedMentionWatcher({config},['configured'],{},{load:async()=>saved??checkpoint,list:async()=>[changed],save:async x=>{saved=x;},deliver:async e=>out.push(e)});
 await make().scan();assert.equal(out.length,1);await make().scan();assert.equal(out.length,1);assert.doesNotMatch(JSON.stringify(saved.checkpoint),/edited while offline/);
});
test('a checkpoint belonging to another bot is never reused; overlapping scans share one read',async()=>{
 const f=fixture();await f.watcher.scan();let calls=0;const w=new EditedMentionWatcher({config:{botOpenId:'other'}},['configured'],{},{load:async()=>f.status.at(-1),list:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return [{...message,updated:true,mentions:[{id:'other'}]}];},save:async()=>{},deliver:async()=>{throw Error('old message must not replay');}});await Promise.all([w.scan(),w.scan()]);assert.equal(calls,1);
});
test('thread rows preserve root and partial thread expansion fails closed',async()=>{
 const {editedMessageRows}=await import('../src/control-plane/edited-mentions.js');const rows=editedMessageRows({messages:[{message_id:'root',thread_replies:[{message_id:'reply'}]}]});assert.equal(rows[1].root_id,'root');assert.throws(()=>editedMessageRows({messages:[{message_id:'root',thread_replies_error:'denied'}]}),/incomplete/);
});
