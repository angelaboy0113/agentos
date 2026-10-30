import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,symlink,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recordBusinessDefinitions as save,readBusinessDefinitions as read,validateDefinitionUpdate} from '../src/shared/business-definitions.js';
import {reportInvestigationContext} from '../src/runner/environment-job.js';
import {buildPrompt} from '../src/runner/codex-executor.js';
const update={title:'项目发生金额',aliases:['项目费用'],definition:'采用已审核活动的实际入账；内部转账和取消返还排除；手动扣减单列，不冲减入账。',quote:'项目费用采用已审核活动实际入账，转账排除。',environment:'prd',previousId:'',previousVersion:0};
async function setup(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'agentos-definitions-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const settings={enabled:true,teams:[{id:'A',projectId:'alpha',chatIds:['g'],profiles:['a']},{id:'B',projectId:'beta',chatIds:['g'],profiles:['b']}]};
 const actor={id:'m1',senderId:'A',chatId:'g',profile:'a',chatType:'group',createdAt:'2026-10-01T00:00:00Z',content:update.quote};
 return {dataDir,settings,actor,projectId:'alpha'};
}
test('confirmed conventions survive restart/age, shared across users but isolated by project/profile/group/environment',async t=>{
 const x=await setup(t);await save({...x,updates:[update]});
 const rows=await read({...x,actor:{...x.actor,senderId:'B'},environment:'prd'});assert.equal(rows.length,1);assert.equal(rows[0].version,1);assert.equal(rows[0].definition,update.definition);assert.equal(rows[0].source,undefined);
 for(const changed of [{profile:'b'},{chatId:'else'},{chatType:'p2p'},{visibility:'requester'}])assert.deepEqual(await read({...x,actor:{...x.actor,...changed}}),[]);
 assert.deepEqual(await read({...x,projectId:'beta'}),[]);assert.deepEqual(await read({...x,environment:'sit'}),[]);
 assert.equal((await stat(path.join(x.dataDir,'knowledge','definitions.sqlite'))).mode&0o777,0o600);
 x.settings.teams[0].membersByProfile={a:['A']};assert.deepEqual(await read({...x,actor:{...x.actor,senderId:'B'}}),[]);
});
test('explicit correction versions replace old conventions; retries idempotent; stale concurrent correction cannot win',async t=>{
 const x=await setup(t),[first]=await save({...x,updates:[update]});
 assert.deepEqual(await save({...x,updates:[update]}),[first]);
 const correction={...update,definition:'采用实际支付金额，内部转账排除，不以入账金额代替。',quote:'更正，项目费用采用实际支付金额。',previousId:first.id,previousVersion:1};
 const actor={...x.actor,id:'m2',createdAt:'2026-10-02T00:00:00Z',content:correction.quote};
 const [next]=await save({...x,actor,updates:[correction]});assert.equal(next.version,2);
 const rows=await read(x);assert.equal(rows.length,1);assert.equal(rows[0].definition,correction.definition);
 await assert.rejects(save({...x,actor:{...actor,id:'late'},updates:[correction]}),/changed/);
 assert.equal((await read(x))[0].version,2);
});
test('no assistant inference, source-less quote, private data, cross-scope correction or symlink target becomes shared memory',async t=>{
 const x=await setup(t);
 await assert.rejects(save({...x,actor:{...x.actor,content:'查一下费用'},updates:[update]}),/current user/);
 assert.throws(()=>validateDefinitionUpdate({...update,definition:'password=hidden-value 请继续'}));
 assert.throws(()=>validateDefinitionUpdate({...update,quote:'项目金额100.00元'}));
 const [first]=await save({...x,updates:[update]});
 await assert.rejects(save({...x,projectId:'beta',actor:{...x.actor,id:'b',profile:'b'},updates:[{...update,previousId:first.id,previousVersion:1}]}),/changed/);
 const other=await mkdtemp(path.join(os.tmpdir(),'agentos-definitions-link-'));t.after(()=>rm(other,{recursive:true,force:true}));await mkdir(path.join(other,'knowledge'));const target=path.join(other,'outside');await writeFile(target,'untouched');await symlink(target,path.join(other,'knowledge','definitions.sqlite'));
 await assert.rejects(save({...x,dataDir:other,updates:[update]}),/Unsafe/);
});
test('the same convention reaches source continuation and environment investigation, not just intake',async()=>{
 const businessDefinitions=[{...update,id:'DEF-test',version:2}];
 const job={id:'job',projectId:'alpha',stage:'developer',taskIntent:'analysis',instruction:'计算本次费用',originalQuestion:'项目费用多少',businessDefinitions};
 const prompt=await buildPrompt(job,{baseBranch:'main'}, {instruction:'read only',metadata:{}},null,[],null);
 assert.ok(prompt.includes(update.definition));assert.deepEqual(reportInvestigationContext(job).businessDefinitions,businessDefinitions);
});
