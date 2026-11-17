import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {LarkEventSource} from '../src/control-plane/lark-event-source.js';
import {explicitSourceEnvironment} from '../src/shared/source-environments.js';

test('explicit original environment subject survives an omitted model routing field without guessing ambiguous scopes',()=>{
 const project={analysisSourceMode:'isolated',analysisEnvironments:{release:{runtimeTier:'prd'},sandbox:{runtimeTier:'uat'}}};
 assert.equal(explicitSourceEnvironment(project,'帮我看看PRD最近三个完整月份的销售，按原PPT做'), 'release');
 assert.equal(explicitSourceEnvironment(project,'SIT环境，核对这两条任务'), 'sandbox');
 assert.equal(explicitSourceEnvironment(project,'查询生产环境中的订单'), 'release');
 for(const text of ['做PPT','https://host/prd环境','`PRD环境`代码片段','PRD环境和SIT环境都查','不是PRD环境','示例PRD环境'])assert.equal(explicitSourceEnvironment(project,text),undefined,text);
 assert.equal(explicitSourceEnvironment({...project,analysisEnvironments:{...project.analysisEnvironments,another:{runtimeTier:'prd'}}},'PRD环境'),undefined);
});

async function fixture(t){const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'topic-input-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));const source=new LarkEventSource({cwd,profile:'bot-a'});let reads=0,downloads=0;const raw={message_id:'om_root',chat_id:'oc_group',msg_type:'file',body:{content:JSON.stringify({file_key:'file-original'})}};source.readMessage=async id=>{reads++;assert.equal(id,'om_root');return structuredClone(raw);};source.downloadAttachments=async e=>{downloads++;const d=path.join(cwd,'messages',e.message_id,e.resourceVersion);await fs.mkdir(d,{recursive:true});const file=path.join(d,'original.pptx');await fs.writeFile(file,'original template bytes');return[{id:e.message_id+'-'+e.resourceVersion.slice(0,16),path:file,type:'file'}];};return{source,raw,event:{message_id:'om_reply',root_id:'om_root',chat_type:'group',chat_id:'oc_group'},count:()=>({reads,downloads}),cwd};}

test('same-profile same-group file topic supplies original bytes and hash-verified reuse, with no repeated download',async t=>{
 const f=await fixture(t),first=await f.source.downloadTopicAttachments(f.event);assert.equal(first.length,1);assert.match(first[0].path,/original.pptx$/);
 assert.deepEqual(await f.source.downloadTopicAttachments(f.event),first);assert.equal(f.count().downloads,1);
 assert.deepEqual(await Promise.all([f.source.downloadTopicAttachments(f.event),f.source.downloadTopicAttachments(f.event)]),[first,first]);assert.equal(f.count().downloads,1);assert.equal(f.source.topicDownloads.size,0);
 await fs.writeFile(first[0].path,'corrupted');await f.source.downloadTopicAttachments(f.event);assert.equal(f.count().downloads,2);
 const originalId=first[0].id;f.raw.body.content=JSON.stringify({file_key:'file-replaced'});const changed=await f.source.downloadTopicAttachments(f.event);assert.notEqual(changed[0].id,originalId);assert.equal(f.count().downloads,3);
});

test('other chats, deleted roots, wrong IDs, private chat and unrelated thread roots cannot supply inputs',async t=>{
 for(const patch of [{chat_id:'oc_other'},{deleted:true},{message_id:'om_other'},{root_id:'om_other'}]){const f=await fixture(t);Object.assign(f.raw,patch);assert.deepEqual(await f.source.downloadTopicAttachments(f.event),[]);assert.equal(f.count().downloads,0);}
 const f=await fixture(t);for(const patch of [{chat_type:'p2p'},{root_id:'../escape'},{message_id:'om_root'}])assert.deepEqual(await f.source.downloadTopicAttachments({...f.event,...patch}),[]);assert.equal(f.count().reads,0);
});

test('plain rich text roots do not download resources, and a cached symlink never supplies external bytes',async t=>{
 const f=await fixture(t);f.raw.msg_type='post';f.raw.body.content=JSON.stringify({text:'ordinary discussion'});assert.deepEqual(await f.source.downloadTopicAttachments(f.event),[]);assert.equal(f.count().downloads,0);
 f.raw.msg_type='file';const [input]=await f.source.downloadTopicAttachments(f.event);await fs.unlink(input.path);const external=path.join(f.cwd,'not-an-input');await fs.writeFile(external,'private');await fs.symlink(external,input.path);
 f.source.downloadAttachments=async()=>{throw Error('Refresh required; cannot reuse symlink');};await assert.rejects(f.source.downloadTopicAttachments(f.event),/Refresh required/);assert.equal(await fs.readFile(external,'utf8'),'private');
});
