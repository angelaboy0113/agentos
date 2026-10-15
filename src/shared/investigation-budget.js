import {acceptedReportResult} from './report-acceptance.js';
const bounded=(v,f,min,max)=>Number.isInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):f;
export function investigationLimits(){return {maxMs:bounded(process.env.AGENTOS_ANALYSIS_TOTAL_TIMEOUT_MS,1200000,60000,7200000),maxRounds:bounded(process.env.AGENTOS_ANALYSIS_MAX_ENV_ROUNDS,8,2,30),maxStagnant:bounded(process.env.AGENTOS_ANALYSIS_MAX_STAGNANT_ROUNDS,2,1,5)};}
export function interruptedInvestigation(job,reason,code='INVESTIGATION_STOPPED'){
 const accepted=acceptedReportResult(job);if(accepted)return {...accepted,supplementaryInvestigationStopped:{code,reason}};
 const entries=(job.context??[]).map(x=>x.result).filter(Boolean);
 const last=[...entries].reverse().find(r=>r.investigation?.goals?.length);
 const gaps=(last?.investigation?.goals??[]).filter(g=>g.required!==false&&g.status!=='verified').map(g=>g.evidence||g.id);
 const findings=entries.filter(r=>r.environmentEvidence||r.handoffGate?.passed).slice(-4).map(r=>r.finalMessage||r.summary).filter(Boolean);
 const files=job.reportFiles??[];const verified=files.filter(f=>/^[a-f0-9]{64}$/.test(f.verificationHash??''));
 return {outcome:'blocked',investigationStopped:{code,reason},summary:`自动调查已停止：${reason}。${findings.length?'已有查询和分析结果已保留，但原问题尚未完整交付。':'本轮未形成可交付结论。'}`,
  finalMessage:[`自动调查已停止：${reason}。这不是已确认的业务故障原因。`,findings.length?'已取得的结果（历史取证，不代表当前状态）\n'+findings.join('\n\n'):'',gaps.length?'尚未完成\n'+gaps.join('\n'):'原问题的完整交付仍未通过核验。',files.length?`已保留 ${files.length} 份文件，其中 ${verified.length} 份通过程序核验；程序核验与原问题交付审阅分开，未接受或需修订的版本不自动发送。`:'','下一步应使用任务内已有成果，仅补查剩余缺口；当前自动调查已停止，不会换一种描述继续开新轮次。'].filter(Boolean).join('\n\n'),verification:[],environmentQuery:null,websiteQuery:null,environmentSetup:null};
}

// Count executing intervals, not hours spent waiting for a person to log in or clarify.
export function investigationElapsed(job,now=Date.now()){
 let total=0,start=null,found=false;
 for(const e of job.events??[]){const at=Date.parse(e.at);if(!Number.isFinite(at))continue;
  if(e.type==='started'){found=true;if(start===null)start=at;}
  if(['completed','failed','cancelled'].includes(e.type)&&start!==null){total+=Math.max(0,at-start);start=null;}
 }
 if(start!==null)total+=Math.max(0,now-start);
 if(!found&&job.createdAt&&['running','queued'].includes(job.status))total=Math.max(0,now-Date.parse(job.createdAt)||0);
 return total;
}
