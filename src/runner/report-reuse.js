import {questionContextIds} from '../shared/question-context.js';
import {deliveredReport} from '../shared/report-context.js';
import {reportFile} from '../shared/report-files.js';
import {reportEligible} from '../shared/report-acceptance.js';
import {inspectReport} from '../shared/report-inspection.js';
import {readFile,lstat,realpath} from 'node:fs/promises';import path from 'node:path';
import {TaskDatasetStore} from './task-dataset-store.js';
export async function reusableReportSources(dataDir,job,scope){
 let s;try{s=JSON.parse(await readFile(path.join(dataDir,'agentos.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}const current=s.jobs?.find(j=>j.id===job.id);
 const identity=j=>[j.projectId,j.chatId,j.senderId,j.originProfile??j.agentProfile,j.sourceEnvironment??null];
 if(!current||JSON.stringify(identity(current))!==JSON.stringify(identity(job))||current.questionId!==job.questionId)return [];
 const qs=questionContextIds(s,current);
 const sameScope=j=>j.projectId===job.projectId&&j.chatId===job.chatId&&(j.originProfile??j.agentProfile)===(job.originProfile??job.agentProfile)&&(j.sourceEnvironment??null)===(job.sourceEnvironment??null);
 const privateJob=j=>j.visibility==='requester'||s.questions?.[j.questionId]?.visibility==='requester';
 const result=[];
 for(const source of s.jobs.filter(j=>j.id!==job.id&&qs.has(j.questionId)&&sameScope(j)&&(!privateJob(j)||job.visibility==='requester'&&j.senderId===job.senderId)&&j.taskIntent==='analysis')){
  const directory=await checkedExportDirectory(dataDir,source.id).catch(()=>null);if(!directory)continue;
  const storage=new TaskDatasetStore(directory,scope);
  let datasets=(await storage.list()).filter(d=>d.kind!=='report_draft');
  let reports=(source.reportFiles??[]).filter(f=>reportEligible(source,f));
  if(source.senderId!==job.senderId){
   // Cross-person reads use only a public, completed, actually delivered file's
   // bound dependency graph. Unpublished auxiliary datasets are not shared.
   if(privateJob(source)||source.status!=='completed')continue;
   reports=reports.filter(f=>deliveredReport(s,source,f));
   let reachable=new Set();
   const visit=async ref=>{if(reachable.has(ref))return;const d=(await storage.get(ref)).data;reachable.add(ref);for(const input of datasetInputs(d))await visit(input);};
   const checked=[];
   for(const f of reports){const previous=new Set(reachable);try{await reportFile(dataDir,source.id,f,{includeContent:false});const receipt=JSON.parse(await readFile(path.join(directory,f.id+'.verification.json'),'utf8'));await visit(receipt.datasetRef);for(const proof of receipt.proofs??[])await visit(proof.datasetRef);checked.push(f);}catch{reachable=previous;/* Missing/corrupt files never widen the shared catalog. */}}
   reports=checked;datasets=datasets.filter(d=>reachable.has(d.datasetRef));
   if(!reports.length)continue;
  }
  if(datasets.length)result.push({jobId:source.id,questionId:source.questionId,datasets,reports:reports.map(f=>({fileId:f.id,rowCount:f.rowCount,sha256:f.sha256}))});
 }
 return result;
}
export async function checkedExportDirectory(dataDir,jobId){
 if(!/^JOB-[A-Za-z0-9-]+$/.test(jobId))throw new Error('来源任务编号无效');
 const base=path.join(dataDir,'exports'),dir=path.join(base,jobId),root=await realpath(dataDir);
 for(const [p,parent] of [[base,root],[dir,await realpath(base)]]){if((await lstat(p)).isSymbolicLink()||path.dirname(await realpath(p))!==parent)throw new Error('来源目录边界无效');}return dir;
}
export async function importReportDataset(datasets,{sourceJobId,datasetRef},sources,dataDir){
 const allowed=sources.find(s=>s.jobId===sourceJobId);if(!allowed?.datasets.some(d=>d.datasetRef===datasetRef))throw new Error('数据集不属于当前任务明确关联的有权读取的关联历史；过期/未关联结果需重新读取');
 const directory=await checkedExportDirectory(dataDir,sourceJobId),storage=new TaskDatasetStore(directory,datasets.storage.scope),seen=new Set(),visiting=new Set();
 const visit=async ref=>{if(seen.has(ref))return;if(visiting.has(ref))throw new Error('复用来源图循环');visiting.add(ref);const d=await storage.get(ref);if(d.data.reportDraft)throw new Error('请复用文件实际来源，不能把旧草稿冒充新文件');
 const refs=datasetInputs(d.data);
 for(const r of refs)await visit(r);await datasets.check();
 try{const existing=await datasets.storage.get(ref);if(existing.dataHash!==d.dataHash)throw new Error('复用引用冲突');}catch(e){if(e.code!=='ENOENT')throw e;await datasets.storage.save(ref,d.data,d.snapshotId,d.readAt);}
 datasets.remember(ref,{...d.data,readAt:d.readAt,snapshotId:d.snapshotId});await datasets.verifyDerived(await datasets.restore(ref));visiting.delete(ref);seen.add(ref);};
 await visit(datasetRef);const d=await datasets.restore(datasetRef);return {datasetRef,complete:true,rowCount:d.rows.length,columns:d.columns,readAt:d.readAt,readThroughAt:d.readThroughAt??d.readAt,snapshotId:d.snapshotId,sourceJobId,importedDatasets:seen.size,reused:true,note:'复用明确关联历史的完整来源，不查询数据库、不更新原取数时间；不是当前实时状态'};
}

export async function inspectReusableReport(dataDir,job,scope,args){
 const allowed=await reusableReportSources(dataDir,job,scope),source=allowed.find(x=>x.jobId===args.sourceJobId);if(!source?.reports.some(f=>f.fileId===args.fileId))throw new Error('文件不是当前明确关联来源中已审阅通过的交付，不读取无关历史');
 const s=JSON.parse(await readFile(path.join(dataDir,'agentos.json'),'utf8')),owner=s.jobs.find(j=>j.id===args.sourceJobId);if(!owner)throw new Error('来源历史已不存在，请重新取数');await checkedExportDirectory(dataDir,owner.id);
 return inspectReport(dataDir,owner,{fileId:args.fileId,section:args.section??'summary',offset:args.offset??0,limit:args.limit??4});
}

function datasetInputs(data){
 if(data.reportDraft)return [...(data.reportDraft.population?[data.reportDraft.population.datasetRef]:[]),...data.reportDraft.sources.map(source=>source.datasetRef)];
 const d=data.derivation;
 if(d?.kind==='relational_transform')return d.inputs;
 if(d?.kind==='left_lookup')return [d.datasetRef,...d.lookups.map(l=>l.datasetRef)];
 if(d?.kind==='period_grid')return [d.args.populationRef,...d.args.sources.map(x=>x.datasetRef)];
 if(d)throw new Error('未知派生格式，需重新核实来源');
 return [];
}
