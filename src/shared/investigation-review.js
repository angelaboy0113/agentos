import { createHash } from 'node:crypto';
const nonempty = s => typeof s === 'string' && s.trim().length > 0;
export const QUESTION_GOAL_ID = 'original-question';
const causalQuestion = /(?:为什么|为何|为啥|原因|根因|怎么回事|咋回事|分析.{0,12}(?:报错|失败|异常)|(?:报错|失败|异常).{0,12}(?:怎么|咋))|(?:\bwhy\b|root\s*cause|what\s+caused|reason\s+for)/i;
const causalUncertainty = /(?:根因|原因|具体(?:超时|失败|异常)?(?:步骤|环节|位置)?).{0,16}(?:未查明|未找到|未确认|不能确认|无法确认|无法确定|不能确定|未知)|(?:尚未|尚不能|无法|不能).{0,12}(?:确认|确定|定位).{0,12}(?:根因|原因|步骤|环节|位置)/;
const diagnosticKinds = new Set(['application_log','runtime_trace','database','source','comparison','calculation','web_runtime']);

export function requiresCausalEvidence(job) {
 return causalQuestion.test(String(job.originalQuestion ?? job.instruction ?? ''));
}

export function causalEvidenceComplete(job,result) {
 if(!requiresCausalEvidence(job))return true;
 const assessment=result.investigation?.causalAssessment;
 if(!assessment||!['confirmed','highly_supported'].includes(assessment.status)
   ||!['direct','reproduced','multi_evidence'].includes(assessment.link)||!nonempty(assessment.mechanism))return false;
 const evidence=(assessment.evidence??[]).filter(item=>nonempty(item?.reference)&&nonempty(item?.finding));
 const direct=evidence.some(item=>item.kind==='business_error');
 const independent=new Set(evidence.filter(item=>diagnosticKinds.has(item.kind)).map(item=>item.kind));
 if(!direct&&independent.size<2)return false;
 const conclusion=[assessment.mechanism,result.investigation?.goals?.find(goal=>goal.id===QUESTION_GOAL_ID)?.evidence,result.summary].filter(Boolean).join(' ');
 return !causalUncertainty.test(conclusion);
}

const questionAnswered=(job,result,root)=>root?.required===true&&root.status==='verified'&&nonempty(root.evidence)&&causalEvidenceComplete(job,result);
// The question is the acceptance target. Investigation leads may aid that target,
// but discovering a new field must not silently expand the user's request.
export function normalizeQuestionScope(job, result) {
 if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||result.sourceSyncBlocked||!['ready','partial','blocked','needs_clarification'].includes(result.outcome))return result;
 const investigation=result.investigation;
 if(!investigation?.goals?.some(goal=>goal.id===QUESTION_GOAL_ID))return result;
 const goals=investigation.goals.map(goal=>goal.id===QUESTION_GOAL_ID?goal:{...goal,required:false});
 let root=goals.find(goal=>goal.id===QUESTION_GOAL_ID);
 const causalIncomplete=requiresCausalEvidence(job)&&root?.status==='verified'&&!causalEvidenceComplete(job,result);
 if(causalIncomplete){root={...root,status:'open'};goals.splice(goals.findIndex(goal=>goal.id===QUESTION_GOAL_ID),1,root);}
 const answered=questionAnswered(job,{...result,investigation:{...investigation,goals}},root);
 const promoted=answered&&result.outcome!=='ready';
 const handoff=result.handoff?{...result.handoff,checks:result.handoff.checks?.map(check=>check.id===QUESTION_GOAL_ID?check:{...check,required:false}),
  ...(answered?{returnTo:'none',risks:[...new Set([...(result.handoff.risks??[]),...(investigation.blocker?[`补充调查受限：${investigation.blocker.needed}`]:[])])]}:{})}:result.handoff;
 const causalNote='用户询问的是原因，但现有材料只证明了现象或候选路径，因果证据尚未闭环。';
 return {...result,outcome:answered?'ready':causalIncomplete&&result.outcome==='ready'?'partial':result.outcome,
  ...(causalIncomplete?{summary:`${causalNote} ${result.summary??''}`.slice(0,1200)}:{}),
  ...(promoted?{summary:`原问题已核实：${root.evidence}。补充调查的限制见详情。`.slice(0,1200),
   finalMessage:`原问题已核实：${root.evidence}\n\n补充调查说明（不影响上述结论）：\n${result.finalMessage??''}`} : {}),
  investigation:{...investigation,goals,status:answered?'complete':investigation.status==='complete'?'continue':investigation.status,
   blocker:answered?null:investigation.blocker},handoff,
  ...(answered?{environmentQuery:null,websiteQuery:null,environmentSetup:null}: {})};
}
export function investigationComplete(job, result) {
 const r=result.investigation;
 if(r?.status!=='complete'||r.blocker||!r.goals?.length)return false;
 if(job.questionScopePolicy==='original-question-v1'&&!r.goals.some(goal=>goal.id===QUESTION_GOAL_ID))return false;
 const ids=new Set();
 const questionScoped=r.goals.some(g=>g.id===QUESTION_GOAL_ID);
 for(const g of r.goals){
  if(!nonempty(g.id)||ids.has(g.id))return false;
  if((questionScoped?g.id===QUESTION_GOAL_ID:g.required!==false)&&!nonempty(g.evidence))return false;
  if(questionScoped?(g.id===QUESTION_GOAL_ID&&(g.required!==true||g.status!=='verified')):(g.required!==false&&g.status!=='verified'))return false;
  ids.add(g.id);
 }
 if(questionScoped)return causalEvidenceComplete(job,result);
 // A later report cannot obtain completion by omitting a previously declared required goal.
 return (job.context??[]).every(x=>(x.result?.investigation?.goals??[])
  .filter(g=>g.required!==false).every(g=>ids.has(g.id)));
}
export function assessInvestigation(job,result){
 result=normalizeQuestionScope(job,result);
 if(job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   && (result.environmentSetup || result.investigation?.status==='wait'&&['login','user_input'].includes(result.investigation?.blocker?.kind)))
  return {...result,outcome:'needs_clarification'};
 if(job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   &&result.outcome==='blocked'&&result.investigation?.status==='wait'&&result.investigation?.blocker?.kind==='unavailable'){
  const goals=result.investigation.goals??[],root=goals.find(goal=>goal.id===QUESTION_GOAL_ID);
  const supportingGoal=goals.some(goal=>goal.id!==QUESTION_GOAL_ID&&goal.status==='verified'&&nonempty(goal.evidence));
  const supportingCause=(result.investigation.causalAssessment?.evidence??[])
   .some(item=>diagnosticKinds.has(item?.kind)&&nonempty(item.reference)&&nonempty(item.finding));
  const usefulEvidence=nonempty(root?.evidence)&&nonempty(result.finalMessage)
   &&result.handoff?.artifacts?.length&&result.handoff?.risks?.length&&(supportingGoal||supportingCause);
  if(usefulEvidence)result={...result,outcome:'partial',handoff:{...result.handoff,returnTo:'none',
   checks:result.handoff.checks?.map(check=>check.id===QUESTION_GOAL_ID&&check.status==='failed'?{...check,status:'not_run'}:check)}};
 }
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
const maxTargetRounds=()=>{const n=Number(process.env.AGENTOS_ENV_TARGET_MAX_ROUNDS);return Number.isInteger(n)&&n>=1&&n<=6?n:3;};
function completedTargetRounds(jobs,request){
 const key=targetKey(request);
 return jobs.reduce((total,item)=>total
  +(item.events??[]).filter(event=>event.type==='continuous_environment_completed'&&targetKey(event)===key).length
  +(item.environmentAccess&&targetKey(item.environmentAccess)===key&&!item.continuousInvestigation&&item.status!=='queued'?1:0),0);
}
const verifiedGoals = result => new Set((result?.investigation?.goals ?? [])
 .filter(goal => goal.status === 'verified' && nonempty(goal.id) && nonempty(goal.evidence)).map(goal => goal.id));
const continuationMetadata = (request,currentResult) => {
 const ids=request?.goalIds;
 if(ids==null)return {ok:true,metadata:null};
 if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!nonempty(id)))
  return {ok:false,reason:'定向补查必须列出1至8个未完成目标 goalIds。'};
 const goals=new Map((currentResult?.investigation?.goals??[]).map(goal=>[goal.id,goal]));
 const invalid=ids.filter(id=>{const goal=goals.get(id);return !goal||goal.required===false||goal.status!=='open';});
 if(invalid.length)return {ok:false,reason:`定向补查只能关联本轮仍未核实的核心目标：${invalid.join('、')}。`};
 const sorted=[...ids].sort();
 const evidence=sorted.map(id=>{const goal=goals.get(id);return [id,goal.status,goal.evidence??''];});
 const evidenceHash=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
 const continuationKey=createHash('sha256').update(JSON.stringify([targetKey(request),sorted,evidenceHash])).digest('hex');
 return {ok:true,metadata:{continuationGoalIds:sorted,continuationEvidenceHash:evidenceHash,continuationKey}};
};

// One environment worker may perform many tool calls. Starting more workers for the
// same target without closing another goal is a stalled orchestration loop.
export function environmentContinuation(state,job,request,currentResult){
 const jobs=(state.jobs??[]).filter(item=>item.questionId===job.questionId&&item.taskIntent==='analysis');
 const contexts=jobs.flatMap(item=>item.context??[]).map(entry=>entry.result).filter(Boolean);
 const targeted=continuationMetadata(request,currentResult);
 if(!targeted.ok)return {continue:false,reason:targeted.reason};
 const targetRounds=completedTargetRounds(jobs,request);
 if(targetRounds>=maxTargetRounds())return {continue:false,reason:`同一环境调查目标已完成${targetRounds}轮；继续串行追加小范围查询会显著增加耗时。请使用本轮受控汇总工具关闭缺口，或根据已有证据给出已确认与未确认项。`};
 const current=verifiedGoals(currentResult);
 let priorBest=new Set();
 for(const result of [...jobs.map(item=>item.result),...contexts]){const found=verifiedGoals(result);if(found.size>priorBest.size)priorBest=found;}
 if([...current].some(id=>!priorBest.has(id)))return {continue:true,metadata:targeted.metadata};
 const priorResults=contexts.filter(result=>targetKey(result.environmentEvidence)===targetKey(request));
 const emptyPartial=priorResults.some(result=>result.outcome==='partial'&&result.environmentEvidence?.rowCount===0);
 if(request?.kind==='website'&&emptyPartial)return {continue:false,reason:'该业务网站目标上一轮未取得记录且调查未完成。请改用已登记数据库、源码或另一条有依据的证据路径，不要换一种描述重复打开同一网站。'};
 const sameTarget=[...jobs.filter(item=>item.environmentAccess&&targetKey(item.environmentAccess)===targetKey(request)),...priorResults];
 if(sameTarget.length<2)return {continue:true,metadata:targeted.metadata};
 if(targeted.metadata){
  const used=jobs.some(item=>(item.continuousContinuationKeys??[]).includes(targeted.metadata.continuationKey)
    ||item.environmentAccess?.continuationKey===targeted.metadata.continuationKey);
  if(!used)return {continue:true,metadata:targeted.metadata};
  return {continue:false,reason:'该剩余目标已经按当前证据完成过一次定向补查；证据没有变化，不能通过改写查询重复执行。'};
 }
 return {continue:false,reason:'同一环境调查目标已经完成两轮独立执行，但原问题的已核实目标没有增加。继续重启任务只会重复已有路径。'};
}
