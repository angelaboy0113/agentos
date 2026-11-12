import {createDocuments,documentFailureResult} from '../shared/document-artifacts.js';
import {validateHandoff,enforceHandoff} from './harness.js';

// File construction is an intermediate step, not delivery or business success.
// A partial analysis may need its first artifact constructed before the ordinary
// handoff can verify it. Never waive unrelated gate failures or final checks.
export async function prepareDocumentHandoff(job,result,workspace,{dataDir}){
 let current=job,gate=await validateHandoff(current,result,workspace,{dataDir});
 const materializable=gate.issues.every(issue=>issue==='部分分析必须有可核验工件、已通过的检查及明确证据缺口');
 if(job.taskIntent==='analysis'&&result.documentRequests?.length&&materializable){
  try{
   const files=await createDocuments(dataDir,job,result.documentRequests);
   current={...job,reportFiles:[...(job.reportFiles??[]),...files]};
   result={...result,exportFiles:[...(result.exportFiles??[]),...files],handoff:{...result.handoff,artifacts:[...(result.handoff?.artifacts??[]),...files.map(f=>({kind:'report',path:f.id}))]}};
   gate=await validateHandoff(current,result,workspace,{dataDir});
  }catch(error){result=documentFailureResult(result,error);gate=await validateHandoff(current,result,workspace,{dataDir});}
 }
 return {job:current,result:enforceHandoff(result,gate)};
}
