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
