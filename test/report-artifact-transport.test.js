import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateHandoff} from '../src/runner/harness.js';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {reportFile} from '../src/shared/report-files.js';
import {prepareReportParts,FEISHU_FILE_PART_BYTES} from '../src/shared/report-parts.js';
import {ReportDelivery} from '../src/control-plane/report-delivery.js';
const digest=x=>createHash('sha256').update(x).digest('hex');
async function root(t){const r=await mkdtemp(path.join(os.tmpdir(),'aos-transport-'));t.after(()=>rm(r,{recursive:true,force:true}));return r;}
const result=artifacts=>({outcome:'ready',handoff:{artifacts,checks:[{id:'complete',required:true,status:'passed',evidence:'verified'}],risks:[],returnTo:'none'}});
async function registered(root,content){const jobId='JOB-source',id='report-'+randomUUID(),filename=id+'.csv',dir=path.join(root,'exports',jobId);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,filename),content);const receipt=Buffer.from(JSON.stringify({version:1,status:'verified',file:{id,sha256:digest(content)},coverage:{rowCount:12000}}));await writeFile(path.join(dir,id+'.verification.json'),receipt);return {id,filename,sha256:digest(content),bytes:content.length,rowCount:12000,verificationHash:digest(receipt),complete:true,sourceJobId:jobId,questionGeneration:1};}
test('report handoff resolves registered task output separately, rejects forged/foreign/tampered paths; source >5MiB streams',async t=>{
 const r=await root(t),workspace=path.join(r,'source');await mkdir(workspace);await writeFile(path.join(workspace,'large.txt'),Buffer.alloc(6*1024*1024,97));const item=await registered(r,Buffer.from('\uFEFF"key"\r\n"1"\r\n')),job={id:'JOB-review',taskIntent:'analysis',reportFiles:[item]};
 const handoff=result([{kind:'code',path:'large.txt'},{kind:'report',path:item.filename}]);const gate=await validateHandoff(job,handoff,workspace,{dataDir:r});assert.deepEqual(gate.issues,[]);assert.equal(gate.verifiedArtifacts[1].namespace,'task-report');assert.equal(gate.verifiedArtifacts[1].sourceJobId,'JOB-source');
 assert.ok((await validateHandoff({...job,reportFiles:[]},handoff,workspace,{dataDir:r})).issues.length);
 for(const p of ['../exports/JOB-source/'+item.filename,'/tmp/'+item.filename,'.env'])assert.ok((await validateHandoff(job,result([{kind:'report',path:p}]),workspace,{dataDir:r})).issues.length);
 assert.ok((await validateHandoff({...job,questionGeneration:2},handoff,workspace,{dataDir:r})).issues.length);
 await writeFile(path.join(r,'exports','JOB-source',item.filename),'changed');assert.ok((await validateHandoff(job,handoff,workspace,{dataDir:r})).issues.length);
 await rm(path.join(r,'exports','JOB-source',item.filename));await symlink(path.join(workspace,'large.txt'),path.join(r,'exports','JOB-source',item.filename));assert.ok((await validateHandoff(job,handoff,workspace,{dataDir:r})).issues.length);
});
test('complete datasets over16MB and reports over10MB and10000 rows persist, finalize and register',async t=>{
 const r=await root(t),rows=Array.from({length:17001},(_,i)=>({id:String(i),text:'值'.repeat(340)}));const d=new ReportDatasets({maxRows:'all',directory:path.join(r,'exports','JOB-large'),scope:'scope'});
 const collected=await d.collect({sql:'all source',params:[],columns:['id','text']},async({sql})=>{const [,n,offset]=sql.match(/LIMIT (\d+) OFFSET (\d+)/);return [rows.slice(+offset,+offset+(+n))];});assert.equal(collected.rowCount,17001);assert.equal(collected.complete,true);
 const draft=await d.compose({sources:[{name:'s1',datasetRef:collected.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'描述',value:{op:'field',source:'s1',column:'text'}}]});assert.ok(draft.draftFile.bytes>16_000_000);
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'all rows',expectedColumns:draft.columns,scopeEvidence:'all source objects',populationRef:collected.datasetRef,populationKey:'id',columnRules:draft.columns.map(label=>({label,definition:'original source value',evidence:'verified source'})),checks:[]});
 const v=await reportFile(r,'JOB-large',final.exportFile,{includeContent:false});assert.equal(v.content,undefined);assert.equal((await d.storage.get(collected.datasetRef)).data.rows.length,17001);
});
test('CSV parts retain quoted newlines, escaped quotes, unicode and all rows; byte fallback reconstructs oversized records',async t=>{
 const r=await root(t),file=path.join(r,'example.csv'),header=Buffer.from('\uFEFF"编号","说明"\r\n'),row=Buffer.from('"a","换行\n含""引号"""\r\n'),content=Buffer.concat([header,...Array.from({length:40},()=>row)]);await writeFile(file,content);
 const p=await prepareReportParts(file,{maxBytes:160});try{const csv=p.parts.filter(p=>p.name.endsWith('.csv'));assert.ok(csv.length>1);const recovered=[];for(const [i,x]of csv.entries()){const b=await readFile(x.file);assert.ok(b.length<=160);assert.ok(b.subarray(0,header.length).equals(header));recovered.push(i?b.subarray(header.length):b);}assert.deepEqual(Buffer.concat(recovered),content);assert.equal(csv.reduce((n,p)=>n+p.rows,0),40);}finally{await p.close();}
 const wide=Buffer.from('\uFEFF"描述"\r\n"'+('文本'.repeat(1000))+'"\r\n');await writeFile(file,wide);const b=await prepareReportParts(file,{maxBytes:256});try{assert.equal(b.mode,'bytes');const parts=b.parts.filter(x=>x.name.endsWith('.bin'));assert.deepEqual(Buffer.concat(await Promise.all(parts.map(p=>readFile(p.file)))),wide);assert.ok(b.parts.every(x=>x.bytes<=256));}finally{await b.close();}
 assert.deepEqual(await readdir(r),['example.csv']);
});
test('real >30MB transport resumes after a failed part, freezes private routing, never duplicates recorded parts',async t=>{
 const r=await root(t),header=Buffer.from('\uFEFF"key","text"\r\n'),row=Buffer.from('"a","'+('x'.repeat(1000))+'"\r\n'),content=Buffer.concat([header,...Array.from({length:31000},()=>row)]);assert.ok(content.length>30_000_000);const item=await registered(r,content);
 const job={id:'JOB-source',questionId:'q',status:'completed',taskIntent:'analysis',result:{outcome:'ready'},reportFiles:[item],reportReviews:{[item.id]:{status:'accepted',verificationHash:item.verificationHash}}};
 const state={jobs:[job],questions:{q:{generation:1,messageId:'om-origin',profile:'owner',visibility:'requester',senderId:'ou_sender'}}};const store={read:async()=>structuredClone(state),transact:async f=>f(state)};let failed=false;const sent=[],attempts=[];
 const context={store,config:{dataDir:r},feishu:{replyFile:async(message,file,options)=>{const bytes=await readFile(file),name=path.basename(file);attempts.push({name,options,message});assert.ok(bytes.length<=FEISHU_FILE_PART_BYTES);assert.equal(options.privateRecipient,'ou_sender');assert.equal(options.profile,'owner');if(name.includes('part0002')&&!failed){failed=true;throw new Error('network');}sent.push({name,bytes});return {data:{message_id:'om-'+sent.length}};}}};
 const first=new ReportDelivery(context);await first.enqueue(job);await first.close();const [key]=Object.keys(state.reportDeliveries);assert.equal(state.reportDeliveries[key].messageId,undefined);assert.equal(state.reportDeliveries[key].parts.length,1);state.reportDeliveries[key].retryAt=0;state.questions.q.profile='changed';const second=new ReportDelivery(context);await second.retry();await second.close();assert.equal(sent.filter(x=>x.name.includes('part0001')).length,1);assert.equal(state.reportDeliveries[key].partCount,3);assert.equal(state.reportDeliveries[key].failures,0);
 const csv=sent.filter(x=>x.name.endsWith('.csv'));assert.deepEqual(Buffer.concat(csv.map((x,i)=>i?x.bytes.subarray(header.length):x.bytes)),content);const part2=attempts.filter(x=>x.name.includes('part0002'));assert.equal(part2[0].options.idempotencyKey,part2[1].options.idempotencyKey);assert.equal(part2[1].message,'om-origin');assert.ok(!(await readdir(path.join(r,'exports','JOB-source'))).some(n=>n.startsWith('.delivery-')));
});
test('generation changes during multipart send stop remaining parts, preserve already sent receipt and clean copies',async t=>{
 const r=await root(t),header=Buffer.from('\uFEFF"key","text"\r\n'),row=Buffer.from('"a","'+('x'.repeat(1000))+'"\r\n'),item=await registered(r,Buffer.concat([header,...Array.from({length:31000},()=>row)]));
 const job={id:'JOB-source',questionId:'q',status:'completed',result:{outcome:'ready'},reportFiles:[item],reportReviews:{[item.id]:{status:'accepted',verificationHash:item.verificationHash}}},state={jobs:[job],questions:{q:{generation:1,messageId:'origin'}}};let calls=0;
 const service=new ReportDelivery({store:{read:async()=>structuredClone(state),transact:async f=>f(state)},config:{dataDir:r},feishu:{replyFile:async()=>{calls++;state.questions.q.generation=2;return {data:{message_id:'first'}};}}});await service.enqueue(job);await service.close();assert.equal(calls,1);const entry=Object.values(state.reportDeliveries)[0];assert.equal(entry.parts[0].messageId,'first');assert.equal(entry.messageId,undefined);assert.ok(!(await readdir(path.join(r,'exports','JOB-source'))).some(n=>n.startsWith('.delivery-')));
});
