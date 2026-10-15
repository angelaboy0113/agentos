import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ReportDatasets} from '../src/runner/report-datasets.js';
import {ReportDelivery} from '../src/control-plane/report-delivery.js';
test('report outbox sends only complete accepted question artifacts, retries delivery, freezes profile and survives restart',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const d=new ReportDatasets({maxRows:10,directory:path.join(root,'exports','JOB-a')});
 const data=await d.collect({sql:'x',columns:['id','amount'],params:[]},async()=>[[{id:'1',amount:'0.1'}]]);
 const report=await d.compose({sources:[{name:'s1',datasetRef:data.datasetRef,keyColumn:'id'}],columns:[{label:'客户',value:{op:'key'}},{label:'金额',value:{op:'field',source:'s1',column:'amount'}}]});
 const source={id:'JOB-a',questionId:'q',reportFiles:[{...report.exportFile,questionGeneration:1}]};
 const job={id:'JOB-b',questionId:'q',status:'running',result:{outcome:'ready'}};
 const state={jobs:[source,job],questions:{q:{messageId:'om-root',profile:'owner',generation:1,replyInThread:true}}};
 const store={read:async()=>structuredClone(state),transact:async fn=>fn(state)};
 let failed=true;const calls=[];const feishu={replyFile:async(message,file,options)=>{calls.push({message,file,options});if(failed)throw new Error('offline');return {data:{message_id:'om-report'}};}};
 const context={store,feishu,config:{dataDir:root}},service=new ReportDelivery(context);
 await service.enqueue(job);assert.equal(calls.length,0);
 job.status='completed';job.result.outcome='partial';await service.enqueue(job);assert.equal(calls.length,0);
 job.result.outcome='ready';await service.enqueue(job);assert.equal(calls.length,1);const [key]=Object.keys(state.reportDeliveries);assert.equal(state.reportDeliveries[key].failures,1);
 assert.equal(calls[0].message,'om-root');assert.equal(calls[0].options.profile,'owner');assert.equal(calls[0].options.replyInThread,true);
 await service.close();state.reportDeliveries[key].retryAt=0;failed=false;state.questions.q.profile='changed';
 const restarted=new ReportDelivery(context);await restarted.retry();assert.equal(calls.length,2);assert.equal(calls[1].options.profile,'owner');assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);await restarted.retry();assert.equal(calls.length,2);assert.equal(state.reportDeliveries[key].messageId,'om-report');await restarted.close();
});
test('old question generations are never sent as the latest report',async()=>{
 const job={id:'j',questionId:'q',status:'completed',result:{outcome:'ready'},reportFiles:[{id:'old',questionGeneration:1}]};
 const state={jobs:[job],questions:{q:{messageId:'root',profile:'owner',generation:2}}};let sent=0;
 const service=new ReportDelivery({store:{read:async()=>structuredClone(state),transact:async f=>f(state)},feishu:{replyFile:async()=>{sent++;}},config:{dataDir:'/unused'}});
 await service.enqueue(job);assert.equal(sent,0);assert.equal(Object.keys(state.reportDeliveries??{}).length,0);await service.close();
});
test('intermediate jobs cannot send and recovery enqueues only the latest completed question job',async()=>{
 const source={id:'source',questionId:'q',status:'completed',nextJobId:'last',result:{outcome:'ready'},reportFiles:[{id:'report',questionGeneration:1}]};
 const last={id:'last',questionId:'q',status:'running',result:{outcome:'ready'}};
 const state={jobs:[source,last],questions:{q:{id:'q',messageId:'root',generation:1,profile:'owner'}}};
 const store={read:async()=>structuredClone(state),transact:async f=>f(state)};
 const service=new ReportDelivery({store,config:{dataDir:'/unused'},feishu:{}});
 await service.enqueue(source);await service.recover();assert.equal(Object.keys(state.reportDeliveries??{}).length,0);
 last.status='completed';await service.recover();assert.equal(Object.keys(state.reportDeliveries??{}).length,1);
 await service.close();
});
test('CLI report reply uses a confined relative file and the original bot profile',async t=>{
 const {writeFile,readFile}=await import('node:fs/promises');const {LarkCliFeishuClient}=await import('../src/control-plane/lark-cli.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'agentos-file-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const entry=path.join(root,'fake-cli.cjs'),file=path.join(root,'report-example.csv');await writeFile(file,'private-csv');
 await writeFile(entry,`const fs=require('fs');const args=process.argv.slice(2);const p=args[args.indexOf('--file')+1];process.stdout.write(JSON.stringify({ok:true,data:{message_id:'sent',args,content:fs.readFileSync(p,'utf8')}}));`);
 const client=new LarkCliFeishuClient({dataDir:root,cliEntry:entry});const result=await client.replyFile('om-original',file,{profile:'owner',replyInThread:true,idempotencyKey:'stable-key'});
 assert.equal(result.ok,true);assert.equal(result.data.content,'private-csv');assert.ok(result.data.args.includes('owner'));assert.ok(result.data.args.includes('--reply-in-thread'));assert.ok(result.data.args.includes('reports/report-example.csv'));assert.equal(await readFile(path.join(root,'lark-cli','reports','report-example.csv'),'utf8'),'private-csv');
});
