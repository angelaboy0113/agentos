import test from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,mkdir,writeFile,readFile,utimes,symlink,access,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {pruneHistory,sweepArtifacts,retentionPolicy} from '../src/shared/retention.js';
import {JsonStore} from '../src/shared/store.js';
import {MemoryService} from '../src/control-plane/memory.js';
import {SessionRegistry} from '../src/control-plane/session-registry.js';
import {KnowledgeStore} from '../src/control-plane/knowledge-store.js';
import {ContactIndex} from '../src/control-plane/contact-index.js';
import {HistoryRetention} from '../src/control-plane/retention.js';
const DAY=86400000,now=Date.parse('2026-10-23T08:00:00Z'),before=new Date(now-40*DAY).toISOString(),recent=new Date(now-DAY).toISOString(),cutoff=now-30*DAY;
const exists=p=>access(p).then(()=>true,()=>false);
async function fixture(t){const d=await realpath(await mkdtemp(path.join(os.tmpdir(),'retention-')));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
const job=(id,status='completed',at=before,questionId='q')=>({id,status,createdAt:at,updatedAt:at,questionId,events:[]});
const state=()=>({jobs:[job('j1'),{...job('j2'),context:[{result:{jobId:'j1'}}]}],conversations:[{id:'t',questionId:'q',createdAt:before,status:'sent'}],questions:{q:{id:'q',createdAt:before,rootTurnId:'t',latestTurnId:'t'}},processedMessages:{msg:'j1'},cardMessages:{'question:q':{revision:1,deliveredRevision:1,mentionDelivered:true}},reportDeliveries:{f:{sourceJobId:'j2',questionId:'q',messageId:'sent'}},controlReceipts:{old:{at:before,jobId:'j1'},fresh:{at:recent}},runners:{old:{lastSeenAt:before},fresh:{lastSeenAt:recent}},effects:{'j1:accept':{job:{id:'j1'}}},adminAudit:[{at:before},{at:recent}]});
test('closed question expires as a complete graph, state cache shrinks and late navigation is detached',async t=>{
 const d=await fixture(t),store=new JsonStore(path.join(d,'agentos.json')),s=state();s.questions.new={id:'new',createdAt:recent,parentQuestionId:'q'};
 await store.write(s);await store.snapshot();const r=await store.transact(x=>pruneHistory(x,cutoff));
 assert.deepEqual([...r.removed].sort(),['j1','j2','q','t']);const saved=await store.read();
 assert.equal(saved.jobs.length,0);assert.equal(saved.conversations.length,0);assert.equal(saved.questions.new.parentQuestionId,undefined);assert.deepEqual(saved.processedMessages,{});assert.deepEqual(saved.cardMessages,{});assert.deepEqual(saved.reportDeliveries,{});assert.deepEqual(saved.effects,{});assert.equal(saved.controlReceipts.old,undefined);assert.ok(saved.controlReceipts.fresh);assert.equal(saved.runners.old,undefined);assert.equal(saved.adminAudit.length,1);assert.equal(JSON.parse(store.cache.raw).jobs.length,0);
});
test('active, waiting, recent evidence, undelivered files and mentions protect all dependency stages',()=>{
 for(const change of [s=>s.jobs[1].status='running',s=>s.jobs[1].status='awaiting_clarification',s=>s.jobs[1].status='awaiting_instruction',s=>s.jobs[1].updatedAt=recent,s=>s.conversations[0].status='ready',s=>s.cardMessages['question:q'].mentionDelivered=false,s=>s.reportDeliveries.f.messageId=null,s=>s.environmentEnrollments={e:{id:'e',questionId:'q',createdAt:before,status:'login_required'}}]){
  const s=state();change(s);if(s.cardMessages['question:q'].mentionDelivered===false)s.cardMessages['question:q'].terminalMention={text:'notify'};
  const r=pruneHistory(s,cutoff);
  assert.equal(r.removed.size,0);assert.equal(s.jobs.length,2);assert.ok(s.controlReceipts.old);
 }
 const s=state();s.jobs.push({...job('new','running',recent,'newq'),context:[{jobId:'j1'}]});assert.equal(pruneHistory(s,cutoff).removed.size,0);
});
test('strict cutoff, missing dates and a completed long-running task use latest completion time',()=>{
 const s={jobs:[job('equal','completed',new Date(cutoff).toISOString(),null),{...job('long','completed',before,null),updatedAt:recent},{id:'legacy',status:'completed'}]};
 assert.equal(pruneHistory(s,cutoff).removed.size,0);assert.throws(()=>retentionPolicy(-1));assert.throws(()=>retentionPolicy(1.5));assert.equal(retentionPolicy(0).enabled,false);
});
async function aged(p,content='old'){await mkdir(path.dirname(p),{recursive:true});await writeFile(p,content);await utimes(p,cutoff/1000-100,cutoff/1000-100);}
test('artifact sweep protects live references, recent descendants, symlinks and Git worktrees',async t=>{
 const d=await fixture(t),root=path.join(d,'exports');await mkdir(root);
 for(const id of ['old','keep','fresh','worktree']){await aged(path.join(root,id,'file'));await utimes(path.join(root,id),cutoff/1000-100,cutoff/1000-100);}
 await writeFile(path.join(root,'fresh','new'),'recent');await aged(path.join(root,'worktree','.git'),'gitdir: /never-touch');await utimes(path.join(root,'worktree'),cutoff/1000-100,cutoff/1000-100);
 const outside=path.join(d,'outside');await mkdir(outside);await aged(path.join(outside,'safe'));await symlink(outside,path.join(root,'link'));
 assert.equal(await sweepArtifacts({root,cutoff,paths:new Set([path.join(root,'keep','file')])}),1);
 assert.equal(await exists(path.join(root,'old')),false);for(const id of ['keep','fresh','worktree','link'])assert.equal(await exists(path.join(root,id)),true);
 assert.equal(await sweepArtifacts({root:path.join(root,'link'),cutoff}),0);assert.equal(await exists(path.join(outside,'safe')),true);
});
test('private summaries and persistent sessions expire without resurrecting suppressed retained sources',async t=>{
 const d=await fixture(t),memory=new MemoryService({dataDir:d});await memory.write({version:1,scopes:{old:{updatedAt:before,items:[{ref:'job:old'}]},keep:{updatedAt:recent,items:[{ref:'job:keep'},{ref:'job:old'}]}},tombstones:{keep:['job:keep','job:old']}});
 await memory.prune(cutoff,new Set(['job:old']));const m=await memory.read();assert.equal(m.scopes.old,undefined);assert.deepEqual(m.tombstones.keep,['job:keep']);assert.equal(m.scopes.keep.items.length,1);
 const registry=new SessionRegistry(d);await registry.set('old',{updatedAt:before});await registry.set('keep',{updatedAt:before,pending:'working'});await registry.prune(cutoff,new Set(['keep']));assert.equal(await registry.get('old'),undefined);assert.ok(await registry.get('keep'));
});
test('knowledge and contact SQLite caches remove old payloads and clear hot results',async t=>{
 const d=await fixture(t),knowledge=await new KnowledgeStore(d).open();t.after(()=>knowledge.close());
 knowledge.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?)').run('old','team','prd','topic',1,'active',cutoff-1,JSON.stringify({id:'old'}));knowledge.hot.set('test',['old']);knowledge.expire(cutoff);assert.equal(knowledge.size(),0);assert.equal(knowledge.hot.size,0);
 const contacts=new ContactIndex(d);await contacts.run(db=>db.prepare('INSERT INTO directory VALUES(?,?,?,?)').run('p','hash',cutoff-1,'[]'));await contacts.prune(cutoff);assert.equal(await contacts.run(db=>db.prepare('SELECT COUNT(*) n FROM directory').get().n),0);
});
test('maintenance serializes retries, preserves callbacks/config, and rejects snapshot deletion without manifest',async t=>{
 const d=await fixture(t),store=new JsonStore(path.join(d,'agentos.json'));await store.write(state());
 const callbacks=path.join(d,'lark-cli-events','bot','pending-card-actions','pending.json');await aged(callbacks);const config=path.join(d,'lark-cli-config','bot','config.json');await aged(config);
 const logs=path.join(d,'logs','2026-01-01.stdout.log');await aged(logs);
 const context={config:{retentionDays:30,dataDir:d},store,projects:{projects:{}},conversations:{key:t=>t.id,memory:new MemoryService({dataDir:d})},knowledge:{prune:async()=>{}},contacts:{}};
 const retention=new HistoryRetention(context);const [a,b]=await Promise.all([retention.run(now),retention.run(now)]);assert.deepEqual(a,b);assert.equal(a.ok,true);assert.equal(await exists(logs),false);assert.equal(await exists(callbacks),true);assert.equal(await exists(config),true);
 const root=path.join(d,'snapshots'),bad=path.join(root,'analysis-bad');await aged(path.join(bad,'file'));await utimes(bad,cutoff/1000-100,cutoff/1000-100);assert.equal(await sweepArtifacts({root,cutoff,manifest:true}),0);assert.ok(await exists(bad));
});

test('daily logger writes separate dated streams and never follows an existing log symlink',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const execute=promisify(execFile);
 const d=await fixture(t),root=path.join(d,'logs'),module=new URL('../src/shared/daily-logs.js',import.meta.url).href;
 const code=`import {installDailyLogs} from ${JSON.stringify(module)}; const restore=installDailyLogs(process.argv[1]); process.stdout.write('normal');process.stderr.write('error');restore();`;
 await execute(process.execPath,['--input-type=module','-e',code,root]);const day=new Date().toISOString().slice(0,10);
 assert.equal(await readFile(path.join(root,day+'.stdout.log'),'utf8'),'normal');assert.equal(await readFile(path.join(root,day+'.stderr.log'),'utf8'),'error');
 const outside=path.join(d,'secret');await writeFile(outside,'unchanged');await rm(path.join(root,day+'.stdout.log'));await symlink(outside,path.join(root,day+'.stdout.log'));
 const result=await execute(process.execPath,['--input-type=module','-e',code,root]);assert.match(result.stdout,/daily-log/);assert.equal(await readFile(outside,'utf8'),'unchanged');
});

test('only expired source containers with valid ownership manifests are swept, pending worker keeps records',async t=>{
 const d=await fixture(t),root=path.join(d,'snapshots'),full=path.join(root,'analysis-valid');
 await aged(path.join(full,'workspace','source.java'));await aged(path.join(full,'source-manifest.json'),JSON.stringify({policy:'isolated-environment-source-v1',workspace:path.join(full,'workspace')}));
 for(const dir of ['workspace',''])await utimes(path.join(full,dir),cutoff/1000-100,cutoff/1000-100);
 assert.equal(await sweepArtifacts({root,cutoff,manifest:true}),1);assert.equal(await exists(full),false);
 const s=state();assert.equal(pruneHistory(s,cutoff,{busyCards:new Set(['question:q'])}).removed.size,0);
 const disabled=new HistoryRetention({config:{retentionDays:0}});disabled.start();assert.equal(disabled.timer,undefined);assert.deepEqual(await disabled.run(now),{disabled:true});await disabled.stop();
});
