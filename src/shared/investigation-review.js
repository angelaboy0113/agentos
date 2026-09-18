import { createHash } from 'node:crypto';
const nonempty = s => typeof s === 'string' && s.trim().length > 0;
export function investigationComplete(job, result) {
 const r=result.investigation;
 if(r?.status!=='complete'||r.blocker||!r.goals?.length)return false;
 const ids=new Set();
 for(const g of r.goals){if(!nonempty(g.id)||ids.has(g.id)||g.status!=='verified'||!nonempty(g.evidence))return false;ids.add(g.id);}
 // A later report cannot obtain completion by omitting a previously declared goal.
 return (job.context??[]).every(x=>(x.result?.investigation?.goals??[]).every(g=>ids.has(g.id)));
}
export function assessInvestigation(job,result){
 if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||!['ready','partial'].includes(result.outcome))return result;
 if(investigationComplete(job,result))return result;
 const note='原问题仍有待核实目标，继续自查；尚不能认定排查完成。';
 return {...result,outcome:'partial',summary:result.summary||note,
  handoff: result.handoff ? {...result.handoff,risks:[...new Set([...(result.handoff.risks??[]),note])]} : result.handoff};
}
function signature(result){
 const r=result.investigation;
 // Do not count restated next-step plans, summaries or timestamps as new evidence.
 const evidence=r?.goals?.map(g=>[g.id,g.status,g.evidence]).sort((a,b)=>a[0].localeCompare(b[0]));
 return createHash('sha256').update(JSON.stringify(evidence??result.handoff?.checks??[])).digest('hex');
}
export function reviewDecision(job,result){
 const r=result.investigation,b=r?.blocker;
 if(r?.status==='wait'&&['login','approval','user_input','unavailable'].includes(b?.kind)
   &&nonempty(b.needed)&&nonempty(b.evidence)&&r.attempts?.some(nonempty))
  return {continue:false,reason:`等待外部配合：${b.needed}；已核实的阻碍：${b.evidence}`};
 const prior=(job.context??[]).filter(x=>x.stage==='owner_report'&&x.result?.outcome==='partial').map(x=>x.result);
 const hash=signature(result);
 if(prior.filter(x=>signature(x)===hash).length>=2)
  return {continue:false,reason:'自动自查后仍未取得新证据，已暂停重复排查；请查看详情中的已尝试路径与剩余目标。'};
 return {continue:true};
}
