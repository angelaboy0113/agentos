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
 if(job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   && (result.environmentSetup || result.investigation?.status==='wait'&&['login','user_input'].includes(result.investigation?.blocker?.kind)))
  return {...result,outcome:'needs_clarification'};
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

const targetKey = value => `${value?.environmentId ?? ''}:${value?.queryId ?? ''}`;
const verifiedGoals = result => new Set((result?.investigation?.goals ?? [])
 .filter(goal => goal.status === 'verified' && nonempty(goal.id) && nonempty(goal.evidence)).map(goal => goal.id));

// One environment worker may perform many tool calls. Starting more workers for the
// same target without closing another goal is a stalled orchestration loop.
export function environmentContinuation(state,job,request,currentResult){
 const jobs=(state.jobs??[]).filter(item=>item.questionId===job.questionId&&item.taskIntent==='analysis');
 const current=verifiedGoals(currentResult);
 let priorBest=new Set();
 for(const item of jobs){const found=verifiedGoals(item.result);if(found.size>priorBest.size)priorBest=found;}
 if([...current].some(id=>!priorBest.has(id)))return {continue:true};
 const sameTarget=jobs.filter(item=>item.environmentAccess&&targetKey(item.environmentAccess)===targetKey(request));
 if(sameTarget.length<2)return {continue:true};
 return {continue:false,reason:'同一环境调查目标已经完成两轮独立执行，但原问题的已核实目标没有增加。继续重启任务只会重复已有路径。'};
}
