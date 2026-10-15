import {createHash} from 'node:crypto';
// Text, timestamps and changed goal prose are not preparation evidence.
export function sourcePreparationProgress(job,result,request){
 const progress=job.investigationProgress??{},proof=result?.sourcePreparation;
 if(request?.kind==='website'||(progress.preparationRecoveries??0)>=2||proof?.policy!=='verified-source-query-context-v1'||result.handoffGate?.passed!==true||!result.sourceSync?.workspace||!Array.isArray(proof.evidence)||!proof.evidence.length||proof.evidence.length>8)return null;
 const keys=[];
 for(const item of proof.evidence){
  if(typeof item.path!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256??'')||!result.verifiedArtifacts?.some(a=>a.kind==='code'&&a.path===item.path&&a.sha256===item.sha256&&a.bytes===item.bytes))return null;
  keys.push(createHash('sha256').update(JSON.stringify([request.environmentId,request.queryId,item.path,item.sha256])).digest('hex'));
 }
 const fresh=[...new Set(keys)].filter(key=>!(progress.preparationSeen??[]).includes(key));
 return fresh.length?{sourcePreparationKeys:fresh,sourcePreparationRecovery:true}:null;
}
