import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CloudFiles} from '../src/control-plane/cloud-files.js';
import {cloudFileLinks} from '../src/shared/cloud-file-links.js';
import {inputFileContext,downloadInputFiles} from '../src/runner/input-files.js';
import {conversationCard} from '../src/control-plane/message-cards.js';
import {parseFeishuMessage} from '../src/control-plane/feishu.js';
async function fixture(t,run){const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-cloud-file-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,service:new CloudFiles({config:{dataDir:dir,feishu:{}}},{run,wait:async()=>{}}),turn:{id:'CHAT-one',messageId:'om_cloud',profile:'owner',senderId:'user',chatId:'group',cloudFileLinks:cloudFileLinks('https://tenant.feishu.cn/file/UploadedOne')}};}
test('cloud links parse named rich-text URLs, normalize query/duplicates and ignore unrelated or spoofed hosts',()=>{
 const links=cloudFileLinks('[表格](https://tenant.feishu.cn/drive/file/ABC?from=group) https://tenant.feishu.cn/drive/file/ABC https://tenant.feishu.cn/wiki/WikiOne。 https://tenant.feishu.cn/sheets/SheetOne');assert.equal(links.length,3);assert.equal(links[0].url,'https://tenant.feishu.cn/drive/file/ABC');assert.equal(links[2].type,'sheet');
 for(const value of ['https://tenant.feishu.cn.evil.example/file/A','https://tenant.feishu.cn@evil.example/file/A','https://tenant.feishu.cn:8443/file/A','https://business.example/report','http://tenant.feishu.cn/file/A'])assert.deepEqual(cloudFileLinks(value),[]);
 const p=parseFeishuMessage({message_type:'post',content:{zh_cn:{content:[[{tag:'a',text:'预算表',href:'https://tenant.feishu.cn/file/ABC'}]]}}});assert.equal(cloudFileLinks(p.text)[0].token,'ABC');
});
test('uploaded cloud file downloads actual full bytes, preserves identity, cache and file-analysis manifest',async t=>{
 const calls=[];let contents='客户,金额\nA,10\nB,20\n';const f=await fixture(t,async(args,opts)=>{calls.push({args,opts});assert.ok(args.includes('--as'));assert.equal(args[args.indexOf('--as')+1],'bot');assert.equal(opts.profile,'owner');assert.equal(opts.timeoutMs,false);
 if(args.includes('+inspect'))return {ok:true,data:{type:'file',token:'UploadedOne',title:'明细.csv'}};
 await writeFile(path.join(opts.cwd,'明细.csv'),contents);return {ok:true,data:{path:'明细.csv'}};});
 const phases=[];let r=await f.service.prepare(f.turn,{onProgress:async p=>phases.push(p.phase)});assert.equal(r.issues.length,0);assert.equal(r.attachments.length,1);assert.equal(await readFile(r.attachments[0].path,'utf8'),contents);assert.equal(r.attachments[0].name,'明细.csv');assert.match(r.attachments[0].sha256,/^[a-f0-9]{64}$/);assert.deepEqual(phases,['identify','download','ready']);assert.match(inputFileContext(r.attachments),/明细.csv/);
 await f.service.prepare(f.turn);assert.equal(calls.length,2);contents='客户,金额\nA,99\n';r=await f.service.prepare({...f.turn,id:'CHAT-two'});assert.equal(calls.length,4);assert.equal(await readFile(r.attachments[0].path,'utf8'),contents);
 const local=await downloadInputFiles({id:'JOB-cloud',attachments:r.attachments},{serverUrl:'http://synthetic',runnerToken:'synthetic'},path.join(f.dir,'worker'),async()=>new Response(contents));assert.equal(local[0].sha256,r.attachments[0].sha256);assert.match(local[0].path,/\.csv$/);
});
test('async online export follows same ticket beyond a polling window, ignores next_command and downloads complete artifact',async t=>{
 let polls=0;const f=await fixture(t,async(args,opts)=>{
 if(args.includes('+inspect'))return {data:{type:'sheet',token:'SheetOne',title:'月预算'}};
 if(args.includes('+export'))return {data:{ready:false,timed_out:true,ticket:'same-ticket',next_command:'never execute this string'}};
 if(args.includes('+task_result')){assert.equal(args[args.indexOf('--ticket')+1],'same-ticket');assert.equal(args[args.indexOf('--file-token')+1],'SheetOne');return {data:++polls<65?{ready:false}:{ready:true,file_token:'OutputFile'}};}
 assert.ok(args.includes('+export-download'));await writeFile(path.join(opts.cwd,'月预算.xlsx'),'complete-export-bytes');return {data:{path:'月预算.xlsx'}};
 });const r=await f.service.prepare({...f.turn,cloudFileLinks:cloudFileLinks('https://tenant.feishu.cn/sheets/SheetOne')});assert.equal(polls,65);assert.equal(r.issues.length,0);assert.equal(r.attachments[0].exported,true);assert.match(r.attachments[0].name,/\.xlsx$/);
});
test('missing app scopes and unshared file remain distinct and do not impersonate personal account',async t=>{
 const f=await fixture(t,async()=>{throw Object.assign(new Error('secret raw diagnostic must not reach user'),{cliError:{subtype:'missing_scope',missing_scopes:['drive:drive.readonly','drive:file:download']}});});let r=await f.service.prepare(f.turn);assert.equal(r.issues[0].code,'CLOUD_APP_SCOPE_MISSING');assert.equal(r.issues[0].suggestedScope,'drive:file:download');assert.match(r.issues[0].message,/其中一项/);assert.doesNotMatch(JSON.stringify(r.issues),/secret raw/);
 f.service.run=async()=>{throw Object.assign(new Error('raw'),{cliError:{type:'permission_denied',code:403}});};r=await f.service.prepare(f.turn);assert.equal(r.issues[0].code,'CLOUD_FILE_ACCESS_DENIED');assert.equal(r.attachments.length,0);
 let invoked=false;f.service.run=async()=>{invoked=true;};r=await f.service.prepare({...f.turn,profile:null});assert.equal(r.issues[0].code,'CLOUD_BOT_PROFILE_MISSING');assert.equal(invoked,false);
});
test('one unavailable file preserves other full files and folder targets are explained without scanning a whole drive',async t=>{
 const f=await fixture(t,async(args,opts)=>{if(args.includes('+inspect')){const url=args[args.indexOf('--url')+1];return {data:url.endsWith('Folder')?{type:'folder',token:'Folder'}:{type:'file',token:'UploadedOne',title:'file.txt'}};}await writeFile(path.join(opts.cwd,'file.txt'),'full');return {data:{}};});
 const r=await f.service.prepare({...f.turn,cloudFileLinks:cloudFileLinks('https://tenant.feishu.cn/file/UploadedOne https://tenant.feishu.cn/drive/folder/Folder')});assert.equal(r.attachments.length,1);assert.equal(r.issues[0].code,'CLOUD_FOLDER_SELECTION');
});
test('path escapes from downloaded cloud file are rejected before model input; explicit shutdown propagates',async t=>{
 const f=await fixture(t,async(args,opts)=>{if(args.includes('+inspect'))return {data:{type:'file',token:'X',title:'outside.txt'}};const outside=path.join(f.dir,'outside.txt');await writeFile(outside,'outside');await symlink(outside,path.join(opts.cwd,'outside.txt'));return {data:{}};});let r=await f.service.prepare(f.turn);assert.equal(r.attachments.length,0);assert.equal(r.issues[0].code,'CLOUD_INPUT_PATH');
 const controller=new AbortController();controller.abort();await assert.rejects(f.service.prepare(f.turn,{signal:controller.signal}),{name:'AbortError'});
});
test('card shows actual cloud download phase and waits for readable input without claiming final analysis',()=>{
 const t={role:'owner_intake',status:'thinking',createdAt:new Date().toISOString(),cloudFileProgress:{phase:'waiting_export',current:1,total:2,name:'预算.xlsx'}};assert.match(JSON.stringify(conversationCard(t)),/等待飞书完成/);
 const card=conversationCard({...t,status:'sent',cloudInputPending:true,response:'请共享文件'});assert.equal(card.header.template,'orange');assert.match(JSON.stringify(card),/等待云文件就绪/);
});

test('pending export survives local restart and resumes same ticket without creating a new export',async t=>{
 const controller=new AbortController();let exports=0,lookups=0;const f=await fixture(t,async(args,opts)=>{
 if(args.includes('+inspect'))return {data:{type:'docx',token:'DocumentOne',title:'流程说明'}};
 if(args.includes('+export')){exports++;return {data:{ready:false,ticket:'persistent-ticket',timed_out:true}};}
 if(args.includes('+task_result')){lookups++;assert.equal(args[args.indexOf('--ticket')+1],'persistent-ticket');return {data:{ready:true,file_token:'ExportOne'}};}
 await writeFile(path.join(opts.cwd,'流程说明.md'),'complete document');return {data:{}};
 });f.service.wait=async()=>{controller.abort();controller.signal.throwIfAborted();};await assert.rejects(f.service.prepare(f.turn,{signal:controller.signal}),{name:'AbortError'});
 const resumed=new CloudFiles(f.service.context,{run:f.service.run,wait:async()=>{}});const r=await resumed.prepare(f.turn);assert.equal(exports,1);assert.equal(lookups,1);assert.equal(r.issues.length,0);assert.equal(await readFile(r.attachments[0].path,'utf8'),'complete document');
});
