import {sourceRuntimeTier} from './source-environments.js';
// Original user scope only: generated plans/history cannot widen authorization.
export function requestedSourceEnvironments(job,project){
 const current=job.sourceEnvironment??project?.defaultSourceEnvironment,text=String(job.originalQuestion??'').toLowerCase();
 const test=/(?:\bsit\b|\buat\b|\btest(?:ing)?\b|测试(?:机|环境)?)/.test(text),prod=/(?:\bprd\b|\bprod(?:uction)?\b|生产(?:机|环境)?)/.test(text);
 const paired=/(?:测试(?:机|环境)?|\bsit\b|\buat\b|\btest(?:ing)?\b)[^。！？\n]{0,20}(?:和|与|及|、|and|versus|vs\.?|&|\/)[^。！？\n]{0,20}(?:生产(?:机|环境)?|\bprd\b|\bprod(?:uction)?\b)|(?:生产(?:机|环境)?|\bprd\b|\bprod(?:uction)?\b)[^。！？\n]{0,20}(?:和|与|及|、|and|versus|vs\.?|&|\/)[^。！？\n]{0,20}(?:测试(?:机|环境)?|\bsit\b|\buat\b|\btest(?:ing)?\b)|(?:分别|两个环境|两套环境|both|compare|比较|对比|差异)/i.test(text);
 const excluded=/(?:不要|不查|不含|不涉及|不包含|排除|无需|仅|只)(?:看|查|读|调查|核对|分析)?\s*(?:sit|uat|test|prd|prod|测试|生产)|\b(?:not|except|exclude|only)\s+(?:sit|uat|test|prd|prod)/i.test(text);
 if(!test||!prod||!paired||excluded||/(?:测试(?:机|环境)?|生产(?:机|环境)?|\bsit\b|\bprd\b)\s*(?:不涉及|不查|排除)/i.test(text)||project?.analysisSourceMode!=='isolated')return current?[current]:[];
 const tiers=Object.keys(project.analysisEnvironments??{}).map(id=>[id,sourceRuntimeTier(project,id)]),selected=['uat','prd'].map(t=>tiers.filter(([id,tier])=>tier===t));
 if(selected.some(list=>list.length!==1))return current?[current]:[];
 return [...new Set([current,...selected.map(list=>list[0][0])].filter(Boolean))];
}
export function comparisonTarget(job,project,request){
 if(!request||typeof request.environmentId!=='string'||typeof request.reason!=='string'||!request.reason.trim())throw Error('源码环境接续需要明确已登记环境及调查目标');
 if(!requestedSourceEnvironments(job,project).includes(request.environmentId)||request.environmentId===job.sourceEnvironment)throw Error('源码环境不在用户原始双环境请求范围内，或已是当前环境');
 return request.environmentId;
}
export function comparisonContext(job,project){return {requested:requestedSourceEnvironments(job,project),active:job.sourceEnvironment,evidence:Object.fromEntries(Object.entries(job.sourceEnvironmentEvidence??{}).map(([env,e])=>[env,{environment:env,workspace:e.workspace,cacheKey:e.sourceSync?.cacheKey,repositories:e.sourceSync?.repositories?.map(r=>({path:r.path,branch:r.branch,commit:r.commit})),summary:e.summary,verifiedArtifacts:e.verifiedArtifacts}])),rule:'各环境独立固定提交、工作区、会话和取数时间。只允许原始问题明确要求的环境；源码切换不授予数据库权限。核实本环境后一次交接必要表/字段与接口规则，切换用sourceEnvironmentQuery，不用跨环境数据库请求代替源码准备。已有环境结论只补差异，不重复宽泛调查。最终分别标明源码事实、实际元数据、部署和外部调用证据缺口。'};}
export function requireComparisonContinuation(job,project,result){
 if(!job.continuousInvestigation||job.taskIntent!=='analysis'||job.stage!=='developer')return result;
 const missing=requestedSourceEnvironments(job,project).find(env=>env!==job.sourceEnvironment&&!job.sourceEnvironmentEvidence?.[env]);
 const request=result.sourceEnvironmentQuery??(result.outcome==='ready'&&missing?{environmentId:missing,reason:'继续原始问题明确要求的另一环境，独立核对源码和证据'}:null);
 if(!request)return result;
 return {...result,outcome:'needs_clarification',sourceEnvironmentQuery:request,environmentQuery:null,websiteQuery:null,environmentSetup:null,
  investigation:result.investigation?{...result.investigation,status:'continue',blocker:null,goals:result.investigation.goals?.map(g=>g.id==='original-question'?{...g,status:'open'}:g)}:result.investigation};
}
