import {createDocuments,documentFailureResult} from '../shared/document-artifacts.js';
import {validateHandoff,enforceHandoff} from './harness.js';
import {reportFile} from '../shared/report-files.js';

// A model may explicitly accept an independently inspected report but omit its
// artifact list entry. Bind only that declared, hash-matched report; never infer
// passed checks, remove risks, waive business goals or claim delivery.
export async function bindReviewedReportArtifacts(job,result,dataDir){
 if(job.taskIntent!=='analysis'||!['ready','partial'].includes(result.outcome)||!result.handoff||!Array.isArray(result.handoff.artifacts)||!dataDir)return result;
 const assessment=result.reportAssessment;if(!assessment||!['deliver','deliver_partial'].includes(assessment.decision))return result;
 const ids=[assessment.fileId,...(assessment.deliverables??[]).map(x=>x.fileId)].filter(x=>typeof x==='string');
 const reviews=[job.reportEvidence,...(job.reportEvidence?.relatedReports??[])].filter(x=>x?.status==='verified');const added=[];
 for(const id of new Set(ids)){
  const file=job.reportFiles?.find(x=>x.id===id),e=reviews.find(x=>x.binding?.fileId===id);
  if(!file||!e||e.binding.sourceJobId!==(file.sourceJobId??job.id)||e.binding.sha256!==file.sha256||e.binding.verificationHash!==file.verificationHash)continue;
  if(job.questionGeneration!==undefined&&file.questionGeneration!==undefined&&job.questionGeneration!==file.questionGeneration)continue;
  if(result.handoff.artifacts.some(x=>x.kind==='report'&&[file.id,file.filename].includes(x.path)))continue;
  try{await reportFile(dataDir,file.sourceJobId??job.id,file,{includeContent:false});added.push({kind:'report',path:file.id});}catch{/* Ordinary gate reports missing/unreadable evidence. */}
 }
 return added.length?{...result,handoff:{...result.handoff,artifacts:[...result.handoff.artifacts,...added]}}:result;
}

// A failed visual check can authorize constructing a replacement PNG in this
// task. The original requirement remains open until the new picture is reviewed.
export function prdPrototypeRevision(job,result,gate) {
 if(!job.prd?.auto||result.outcome!=='partial'||result.reportAssessment?.decision!=='revise'
   ||result.investigation?.status!=='continue'||result.investigation?.blocker
   ||result.documentRequests?.length!==1||result.documentRequests[0].format!=='png'
   ||!gate.issues.length||gate.issues.some(issue=>issue!=='必需验收项失败：original-question'
      &&issue!=='部分分析必须有可核验工件、已通过的检查及明确证据缺口'))return null;
 const file=job.reportFiles?.find(f=>f.id===result.reportAssessment.fileId&&f.format==='png'
   &&(job.questionGeneration===undefined||f.questionGeneration===job.questionGeneration));
 if(!file)return null;
 const reviews=[job.reportEvidence,...(job.reportEvidence?.relatedReports??[])];
 if(!reviews.some(e=>e?.status==='verified'&&e.binding?.sourceJobId===job.id&&e.binding.fileId===file.id
   &&e.binding.sha256===file.sha256&&e.binding.verificationHash===file.verificationHash))return null;
 return file;
}

// File construction is an intermediate step, not delivery or business success.
// A partial analysis may need its first artifact constructed before the ordinary
// handoff can verify it. Never waive unrelated gate failures or final checks.
export async function prepareDocumentHandoff(job,result,workspace,{dataDir,emit=async()=>{},createFiles=createDocuments}){
 result=await bindReviewedReportArtifacts(job,result,dataDir);
 let current=job,gate=await validateHandoff(current,result,workspace,{dataDir});
 const candidate=prdPrototypeRevision(job,result,gate);
 const materializable=candidate||gate.issues.every(issue=>issue==='部分分析必须有可核验工件、已通过的检查及明确证据缺口');
 if(job.taskIntent==='analysis'&&result.documentRequests?.length&&materializable){
  try{
   const files=await createFiles(dataDir,job,result.documentRequests,{onProgress:event=>emit({type:'progress',...event})});
   if(candidate&&files.some(f=>f.sha256===candidate.sha256))throw Object.assign(Error('修订原型与待修订文件一致'),{code:'PRD_IMAGE_UNCHANGED'});
   if(candidate)result={...result,reportReviewRequired:true,handoff:{...result.handoff,
    risks:[...(result.handoff.risks??[]),'修订图已生成，仍需对照现场截图验收。'],
    checks:[...result.handoff.checks.filter(check=>check.id!=='prd-prototype-file').map(check=>
     check.id==='original-question'&&check.status==='failed'?{...check,status:'not_run'}:check),
    {id:'prd-prototype-file',required:false,status:'passed',evidence:'新 PNG 已完成文件生成与结构校验，文件 '+files[0].id}]}};
   current={...job,reportFiles:[...(job.reportFiles??[]),...files]};
   result={...result,exportFiles:[...(result.exportFiles??[]),...files],handoff:{...result.handoff,artifacts:[...(result.handoff?.artifacts??[]),...files.map(f=>({kind:'report',path:f.id}))]}};
   gate=await validateHandoff(current,result,workspace,{dataDir});
  }catch(error){result=documentFailureResult(result,error);gate=await validateHandoff(current,result,workspace,{dataDir});}
 }
 return {job:current,result:enforceHandoff(result,gate)};
}
