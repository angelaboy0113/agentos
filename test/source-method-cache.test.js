import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {rememberSourceMethod,loadSourceMethod} from '../src/runner/source-method-cache.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'method-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));const workspace=path.join(root,'snapshot'),dataDir=path.join(root,'data');await mkdir(workspace);await mkdir(dataDir);const body='// Current code\nclass Invoice {\n String reference; // business invoice identity\n}\n';await writeFile(path.join(workspace,'Invoice.java'),body);const sync={workspace,cacheKey:'fixed',environment:'prd',remoteCheckedAt:new Date().toISOString(),repositorySources:[{path:'.',originHash:'source'}],repositories:[{path:'.',branch:'prd',commit:'a'.repeat(40)}]},job={projectId:'a',chatId:'group1',agentProfile:'assistant1',taskIntent:'analysis',stage:'developer',originalQuestion:'查询客户订单销售金额及订单数量，不同客户分别汇总',businessDefinitions:[{id:'d',version:1}]},result={workspace,handoffGate:{passed:true},verifiedArtifacts:[{kind:'code',path:'Invoice.java',sha256:sha(body),bytes:Buffer.byteLength(body)}],finalMessage:'Invoice.java:3',handoff:{checks:[{evidence:'current identity rule'}]}};return {root,workspace,dataDir,body,sync,job,result};}
test('same-version related request receives current verified code hints, never previous results or query values',async t=>{
 const f=await fixture(t);assert.equal((await rememberSourceMethod(f.job,f.sync,{...f.result,summary:'PRIVATE_BUSINESS_AMOUNT_999',rows:[{secret:'PRIVATE_ROW'}]},{dataDir:f.dataDir})).saved,true);
 const hit=await loadSourceMethod({...f.job,originalQuestion:'查询其他客户订单销售金额及订单数量，不同客户分别汇总'},f.sync,{dataDir:f.dataDir});assert.equal(hit.matchedFiles,1);assert.match(hit.source.sources[0].excerpt,/business invoice identity/);assert.equal(hit.currentAmountsReused,false);
 const dirs=await readdir(path.join(f.dataDir,'source-methods')),files=await readdir(path.join(f.dataDir,'source-methods',dirs[0]));const text=await readFile(path.join(f.dataDir,'source-methods',dirs[0],files[0]),'utf8');assert.doesNotMatch(text,/PRIVATE_BUSINESS_AMOUNT|PRIVATE_ROW|business invoice identity|查询客户|group1/);
});
test('system/profile/chat/tier/commit/origin and confirmed-definition versions isolate evidence reuse',async t=>{
 const f=await fixture(t);await rememberSourceMethod(f.job,f.sync,f.result,{dataDir:f.dataDir});
 for(const j of [{projectId:'b'},{agentProfile:'assistant2'},{chatId:'group2'},{businessDefinitions:[{id:'d',version:2}]}])assert.equal(await loadSourceMethod({...f.job,...j},f.sync,{dataDir:f.dataDir}),null);
 for(const s of [{environment:'uat'},{cacheKey:'new'},{repositorySources:[{path:'.',originHash:'other'}]},{repositories:[{path:'.',branch:'prd',commit:'b'.repeat(40)}]},{remoteCheckedAt:null}])assert.equal(await loadSourceMethod(f.job,{...f.sync,...s},{dataDir:f.dataDir}),null);
 assert.equal(await loadSourceMethod({...f.job,originalQuestion:'解释定时任务调度状态以及失败日志'},f.sync,{dataDir:f.dataDir}),null);
});
test('changed bodies and symlinks cannot be reused; rejected handoffs cannot write the index',async t=>{
 const f=await fixture(t);assert.equal((await rememberSourceMethod(f.job,f.sync,{...f.result,handoffGate:{passed:false}},{dataDir:f.dataDir})).saved,false);
 await rememberSourceMethod(f.job,f.sync,f.result,{dataDir:f.dataDir});await writeFile(path.join(f.workspace,'Invoice.java'),'changed');assert.equal(await loadSourceMethod(f.job,f.sync,{dataDir:f.dataDir}),null);
 await rm(path.join(f.workspace,'Invoice.java'));await symlink('/etc/passwd',path.join(f.workspace,'Invoice.java'));assert.equal(await loadSourceMethod(f.job,f.sync,{dataDir:f.dataDir}),null);
});
test('concurrent immutable writes are atomic and corrupted optional cache falls back without harming source',async t=>{
 const f=await fixture(t);await Promise.all(Array.from({length:5},()=>rememberSourceMethod(f.job,f.sync,f.result,{dataDir:f.dataDir})));assert.ok(await loadSourceMethod(f.job,f.sync,{dataDir:f.dataDir}));
 const dirs=await readdir(path.join(f.dataDir,'source-methods')),dir=path.join(f.dataDir,'source-methods',dirs[0]);assert.equal((await readdir(dir)).filter(n=>n.endsWith('.tmp')).length,0);for(const n of await readdir(dir))await writeFile(path.join(dir,n),'corrupt');assert.equal(await loadSourceMethod(f.job,f.sync,{dataDir:f.dataDir}),null);assert.equal(await readFile(path.join(f.workspace,'Invoice.java'),'utf8'),f.body);
});
test('cache directory links cannot write outside private data root',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,path.join(f.dataDir,'source-methods'));await assert.rejects(rememberSourceMethod(f.job,f.sync,f.result,{dataDir:f.dataDir}),/Unsafe/);assert.equal((await readdir(outside)).length,0);
});

test('resume prompt keeps current evidence hints separate from historical amounts and authorizations',async t=>{
 const f=await fixture(t);await rememberSourceMethod(f.job,f.sync,f.result,{dataDir:f.dataDir});const hints=await loadSourceMethod(f.job,f.sync,{dataDir:f.dataDir});
 assert.equal(hints.policy,'verified-source-method-hints-v1');assert.match(hints.note,/权限必须本次重新核验/);assert.ok(hints.source.sources.every(s=>!Object.hasOwn(s,'root')));
});
