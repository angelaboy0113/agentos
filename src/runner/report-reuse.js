import {reportEligible} from '../shared/report-acceptance.js';
import {inspectReport} from '../shared/report-inspection.js';
import {readFile,lstat,realpath} from 'node:fs/promises';import path from 'node:path';
import {TaskDatasetStore} from './task-dataset-store.js';
export async function reusableReportSources(dataDir,job,scope){
 let s;try{s=JSON.parse(await readFile(path.join(dataDir,'agentos.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}const current=s.jobs?.find(j=>j.id===job.id);
 const identity=j=>[j.projectId,j.chatId,j.senderId,j.originProfile??j.agentProfile,j.sourceEnvironment??null];
 if(!current||JSON.stringify(identity(current))!==JSON.stringify(identity(job))||current.questionId!==job.questionId)return [];
 const qs=new Set();let q=s.questions?.[current.questionId];
 while(q&&!qs.has(q.id)&&q.projectId===job.projectId&&q.chatId===job.chatId&&q.senderId===job.senderId&&q.profile===(job.originProfile??job.agentProfile)){qs.add(q.id);q=s.questions[q.parentQuestionId];}
 const result=[];
 for(const source of s.jobs.filter(j=>j.id!==job.id&&qs.has(j.questionId)&&JSON.stringify(identity(j))===JSON.stringify(identity(job))&&j.taskIntent==='analysis')){
  const directory=await checkedExportDirectory(dataDir,source.id).catch(()=>null);if(!directory)continue;
  const storage=new TaskDatasetStore(directory,scope),datasets=(await storage.list()).filter(d=>d.kind!=='report_draft');
  if(datasets.length)result.push({jobId:source.id,questionId:source.questionId,datasets,reports:(source.reportFiles??[]).filter(f=>reportEligible(source,f)).map(f=>({fileId:f.id,rowCount:f.rowCount,sha256:f.sha256}))});
 }
 return result;
}
export async function checkedExportDirectory(dataDir,jobId){
 if(!/^JOB-[A-Za-z0-9-]+$/.test(jobId))throw new Error('来源任务编号无效');
 const base=path.join(dataDir,'exports'),dir=path.join(base,jobId),root=await realpath(dataDir);
 for(const [p,parent] of [[base,root],[dir,await realpath(base)]]){if((await lstat(p)).isSymbolicLink()||path.dirname(await realpath(p))!==parent)throw new Error('来源目录边界无效');}return dir;
}
export async function importReportDataset(datasets,{sourceJobId,datasetRef},sources,dataDir){
 const allowed=sources.find(s=>s.jobId===sourceJobId);if(!allowed?.datasets.some(d=>d.datasetRef===datasetRef))throw new Error('数据集不属于当前任务明确关联的同身份历史；过期/未关联结果需重新读取');
 const directory=await checkedExportDirectory(dataDir,sourceJobId),storage=new TaskDatasetStore(directory,datasets.storage.scope),seen=new Set(),visiting=new Set();
 const visit=async ref=>{if(seen.has(ref))return;if(visiting.has(ref))throw new Error('复用来源图循环');visiting.add(ref);const d=await storage.get(ref);if(d.data.reportDraft)throw new Error('请复用文件实际来源，不能把旧草稿冒充新文件');
 const derivation=d.data.derivation;let refs=[];
 if(derivation?.kind==='relational_transform')refs=derivation.inputs;
 else if(derivation?.kind==='left_lookup')refs=[derivation.datasetRef,...derivation.lookups.map(l=>l.datasetRef)];
 else if(derivation?.kind==='period_grid')refs=[derivation.args.populationRef,...derivation.args.sources.map(x=>x.datasetRef)];
 else if(derivation)throw new Error('未知派生格式，需重新核实来源');
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
