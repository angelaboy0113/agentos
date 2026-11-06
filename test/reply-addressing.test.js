import test from 'node:test';import assert from 'node:assert/strict';
import {ReplyAddressing,addressingSettings,salutation,addressText,addressCard} from '../src/control-plane/reply-addressing.js';
const policy={enabled:true,profiles:['one','two'],chatIds:['oc_group','oc_other'],enabledSince:'2026-01-01T00:00:00Z',fallback:'老师',displayNameOverrides:{'特定姓名':'专用称呼'}};
const turn={profile:'one',chatId:'oc_group',senderId:'ou_a',createdAt:'2026-02-01T00:00:00Z'};
const context=feishu=>({config:{},feishu});
test('display-name policy supports overrides, ordinary/compound names and unknown names without gender or identity rules',()=>{
 const p=addressingSettings(policy);
 for(const [name,want] of [['特定姓名','专用称呼'],['王小明','小明老师'],['王明','王明老师'],['欧阳明','欧阳明老师'],['司马思颖','司马思颖老师'],['Atreus','Atreus老师'],['小太阳','小太阳老师'],['李老师','李老师'],['','老师'],['<at user_id=x>','老师']])assert.equal(salutation(name,p),want);
 assert.equal(salutation('特定姓名',p),'专用称呼'); // Same display name, independent of ID.
 assert.throws(()=>addressingSettings({...policy,enabledSince:'yesterday'}));
 assert.throws(()=>addressingSettings({...policy,displayNameOverrides:{x:'<at>'}}));
});
test('same-profile/group lookups deduplicate concurrent readers, paginate and cache; another bot cannot reuse IDs/names',async()=>{
 const calls=[];const service=new ReplyAddressing(context({groupMembersPage:async(chat,args,o)=>{calls.push([chat,args.pageToken,o.profile]);await Promise.resolve();if(o.profile==='two')return {items:[{member_id:'ou_a',name:'赵小青'}],has_more:false};return args.pageToken?{items:[{member_id:'ou_b',name:'李小平'}],has_more:false}:{items:[{member_id:'ou_a',name:'王小明'}],has_more:true,page_token:'next'};}}),{settings:policy});
 assert.deepEqual(await Promise.all([service.forTurn(turn),service.forTurn({...turn,senderId:'ou_b'})]),['小明老师','小平老师']);assert.equal(calls.length,2);
 assert.equal(await service.forTurn({...turn,profile:'two'}),'小青老师');assert.equal(calls.length,3);
 assert.equal(await service.forTurn({...turn,chatId:'oc_other'}),'小明老师');assert.equal(calls.length,5);
 assert.equal(await service.forTurn({...turn,senderId:'ou_not_found'}),'老师');assert.equal(calls.length,5);
});
test('disabled/wrong-scope/old turns do not fetch names, including profile-specific jobs',async()=>{
 let calls=0;const service=new ReplyAddressing(context({groupMembersPage:async()=>{calls++;throw Error();}}),{settings:policy});
 for(const t of [{...turn,profile:'other'},{...turn,chatId:'oc_unbound'},{...turn,createdAt:'2025-12-31T00:00:00Z'},{...turn,senderId:null}])assert.equal(await service.forTurn(t),'');assert.equal(calls,0);
 assert.equal(await service.forTurn({...turn,profile:undefined,originProfile:'one'}),'老师');assert.equal(calls,1);
 const off=new ReplyAddressing(context({}),{settings:{enabled:false}});assert.equal(await off.forTurn(turn),'');
});
test('permission failures and repeated cursors fall back without failing business execution; failed lookups have short cache',async()=>{
 let now=0,calls=0;const svc=new ReplyAddressing(context({groupMembersPage:async()=>{calls++;throw Error('permission');}}),{settings:policy,now:()=>now});
 assert.equal(await svc.forTurn(turn),'老师');assert.equal(await svc.forTurn(turn),'老师');assert.equal(calls,1);now=61000;assert.equal(await svc.forTurn(turn),'老师');assert.equal(calls,2);
 const cycle=new ReplyAddressing(context({groupMembersPage:async()=>({items:[],has_more:true,page_token:'same'})}),{settings:policy});assert.equal(await cycle.forTurn(turn),'老师');
});
test('name cache refreshes changed display names and formatting leaves titles, buttons, table data and source objects intact',async()=>{
 let now=0,name='王小明';const svc=new ReplyAddressing(context({groupMembersPage:async()=>({items:[{member_id:'ou_a',name}],has_more:false})}),{settings:policy,now:()=>now});
 assert.equal(await svc.forTurn(turn),'小明老师');name='特定姓名';now=900001;assert.equal(await svc.forTurn(turn),'专用称呼');
 const card={header:{title:{content:'原问题'}},body:{elements:[{tag:'column_set',columns:[{elements:[{tag:'markdown',content:'已核实结果。'}]}]},{tag:'table',rows:[{name:'数值'}]},{tag:'button',text:'执行'}]}};
 const formatted=addressCard(card,'小明老师');assert.equal(formatted.body.elements[0].columns[0].elements[0].content,'小明老师，已核实结果。');assert.equal(card.body.elements[0].columns[0].elements[0].content,'已核实结果。');assert.deepEqual(formatted.header,card.header);assert.deepEqual(formatted.body.elements.slice(1),card.body.elements.slice(1));assert.deepEqual(addressCard(formatted,'小明老师'),formatted);assert.equal(addressText('', '老师'),'');
});
test('slow auxiliary naming does not hold up the user business answer',async()=>{
 const svc=new ReplyAddressing(context({groupMembersPage:()=>new Promise(()=>{})}),{settings:policy,lookupMs:10});
 assert.equal(await svc.forTurn(turn),'老师');
});
test('actual conversation and terminal question-card paths address the latest asker without changing authority or results',async t=>{
 const {mkdtemp,rm,writeFile}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createControlPlane}=await import('../src/control-plane/server.js');
 const directory=await mkdtemp(path.join(os.tmpdir(),'addressing-e2e-')),file=path.join(directory,'addressing.json'),sent=[];
 await writeFile(file,JSON.stringify(policy));
 const app=await createControlPlane({dataDir:directory,storeFile:path.join(directory,'state.json'),replyAddressingFile:file,projectsFile:path.join(directory,'projects.json'),conversationFile:path.join(directory,'conversation.json'),memoryFile:path.join(directory,'memory.json'),knowledgeFile:path.join(directory,'knowledge.json'),
   projects:{chatProjectMap:{oc_group:'demo'},projects:{demo:{displayName:'Demo'}},ownerOpenIdsByProfile:{one:['ou_admin']}},agents:{agents:{owner_intake:{profile:'one'},developer:{profile:'dev'}}},
   feishuClient:{replyCard:async(id,card)=>{sent.push(card);return {message_id:'card-'+sent.length};},updateCard:async(id,card)=>{sent.push(card);},reply:async()=>({message_id:'notice'}),groupMembersPage:async()=>({items:[{member_id:'ou_a',name:'王小明'},{member_id:'ou_b',name:'特定姓名'}],has_more:false})},
   conversationOptions:{groupSessions:true,questionCards:true,feedbackMs:0},conversationResponder:async()=>({action:'reply',intent:'none',reply:'已确认结果。',replyDisposition:'answered',instruction:'',projectId:'',jobId:'',attachmentIds:[]})});
 t.after(async()=>{await app.conversations.stop();await app.cards.stop();await rm(directory,{recursive:true,force:true});});
 await app.conversations.enqueue({message_id:'first',chat_id:'oc_group',sender_id:'ou_a',chat_type:'group',agent_profile:'one',agent_role:'owner_intake',content:'请回答'});await app.conversations.idle();
 const s=await app.store.read(),q=Object.values(s.questions)[0];assert.match(JSON.stringify(s.cardMessages['question:'+q.id].card),/小明老师，已确认结果/);
 assert.equal(s.conversations[0].response,'已确认结果。');assert.equal(q.senderId,'ou_a');
 await app.conversations.enqueue({message_id:'second',chat_id:'oc_group',sender_id:'ou_b',chat_type:'group',agent_profile:'one',agent_role:'owner_intake',content:'请继续说明',root_id:'first',reply_to:'first'});await app.conversations.idle();
 const next=await app.store.read(),last=Object.values(next.questions).at(-1);assert.match(JSON.stringify(next.cardMessages['question:'+last.id].card),/专用称呼，已确认结果/);
 assert.equal(next.conversations.at(-1).senderId,'ou_b');
 const created=await app.store.createJob({questionId:last.id,projectId:'demo',chatId:'oc_group',senderId:'ou_b',originProfile:'one',agentProfile:'dev',stage:'developer',workflow:'continuous_analysis',taskIntent:'analysis',instruction:'只读分析',sourceMessageId:'job-after-second'});
 await app.store.transact(state=>{const job=state.jobs.find(j=>j.id===created.job.id);job.status='completed';job.updatedAt=new Date().toISOString();job.result={outcome:'ready',summary:'已核实任务结果。',finalMessage:'已有证据与数据保持原样。'};});
 const {publishQuestion}=await import('../src/control-plane/questions.js');await publishQuestion(app.conversations.context,last.id);
 const final=await app.store.read();assert.match(JSON.stringify(final.cardMessages['question:'+last.id].card),/专用称呼，已有证据与数据保持原样/);assert.equal(final.jobs[0].result.summary,'已核实任务结果。');
});
test('table-only cards get a separate greeting rather than altering a flow footer or business cells',()=>{
 const table={tag:'table',rows:[{amount:'100.00'}]},footer={tag:'markdown',text_size:'notation',content:'流程：开发'};
 const metrics={tag:'column_set',columns:[{elements:[{tag:'markdown',content:'**16 分钟**'}]},{elements:[{tag:'markdown',content:'**20 次**'}]}]};const x=addressCard({body:{elements:[table,metrics,footer]}},'小明老师');assert.equal(x.body.elements[0].content,'小明老师：');assert.deepEqual(x.body.elements.slice(1),[table,metrics,footer]);assert.equal(addressText('## 结论','小明老师'),'小明老师，\n\n## 结论');
});
