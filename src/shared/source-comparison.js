import {sourceRuntimeTier} from './source-environments.js';
// Explicit environment subjects in independent user clauses need no comparison keyword.
// Mask code/URLs: a branch name or an example in a snippet is not a request to inspect it.
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function originalScopeText(value){return String(value??'').toLowerCase().replace(/```[\s\S]*?```|`([^`\n]*)`|https?:\/\/[^\s<>]+/g,(match,inline)=>inline&&/^(?:sit|uat|test|testing|prd|prod|production|测试|生产)$/.test(inline.trim())?inline.trim():' ');}
function independentEnvironmentSubjects(text){
 const names={uat:['sit','uat','test','testing','测试'],prd:['prd','prod','production','生产']};
 const subject=tier=>{
  const labels=[...new Set(names[tier])].sort((a,b)=>b.length-a.length).map(escapeRegex).join('|');
  const pattern=new RegExp('(?:^|[\\s\\p{P}]|核对|查看|查询|看看|查一下|看下|检查|以及|同时|另外|还有|而在|和|与|及|、)(?:在|对于)?\\s*(?:'+labels+')(?:\\s*(?:环境|机|机器|系统|数据库|分支|库|端|environment\\b)(?:中|下|里)?|(?=\\s*(?:有|没有|能|不能|是否|是不是|为什么|怎么|查|看|has\\b|have\\b|can\\b)))','gu');
  let match;while((match=pattern.exec(text))){const prefix=text.slice(Math.max(0,match.index-24),match.index).replace(/[\s\p{P}]+$/gu,'');if(!/(?:叫|名为|名字是|名称是|示例为|示例是|提到|写着|包含字样)\s*$/.test(prefix))return true;}
  return false;
 };
 return subject('uat')&&subject('prd');
}
// Original user scope only: generated plans/history cannot widen authorization.
export function requestedSourceEnvironments(job,project){
 const current=job.sourceEnvironment??project?.defaultSourceEnvironment,text=originalScopeText(job.originalQuestion);
 const independentSubjects=independentEnvironmentSubjects(text);
 const test=/(?:\bsit\b|\buat\b|\btest(?:ing)?\b|测试(?:机|环境)?)/.test(text),prod=/(?:\bprd\b|\bprod(?:uction)?\b|生产(?:机|环境)?)/.test(text);
 const paired=/(?:测试(?:机|环境)?|\bsit\b|\buat\b|\btest(?:ing)?\b)[^。！？\n]{0,20}(?:和|与|及|、|and|versus|vs\.?|&|\/)[^。！？\n]{0,20}(?:生产(?:机|环境)?|\bprd\b|\bprod(?:uction)?\b)|(?:生产(?:机|环境)?|\bprd\b|\bprod(?:uction)?\b)[^。！？\n]{0,20}(?:和|与|及|、|and|versus|vs\.?|&|\/)[^。！？\n]{0,20}(?:测试(?:机|环境)?|\bsit\b|\buat\b|\btest(?:ing)?\b)|(?:分别|两个环境|两套环境|两边|两者|是否一致|不一致|both|compare|比较|对比|差异)/i.test(text)
  // Contrasting the behavior of two explicitly named environments is itself
  // a comparison; users need not also say “compare” or “两边”. Keep exclusions
  // authoritative and do not infer an environment from generated plans.
  || /(?:但是|但我|而在|却|不一样|\bbut\b|\bwhereas\b|\bwhile\b)/i.test(text)
  || independentSubjects;
 const excluded=/(?:不要|不查|不含|不涉及|不包含|排除|无需|仅|只)(?:看|查|读|调查|核对|分析)?\s*(?:sit|uat|test|prd|prod|测试|生产)|(?:并不|不)(?:要求|需要)(?:访问|查询|核对)?\s*(?:sit|uat|test|prd|prod|测试|生产)|(?:不是|不代表|不表示)\s*(?:sit|uat|test|prd|prod|测试|生产)|\b(?:not|except|exclude|only)\s+(?:sit|uat|test|prd|prod)/i.test(text);
 if(((!test||!prod)&&!independentSubjects)||!paired||excluded||/(?:测试(?:机|环境)?|生产(?:机|环境)?|\bsit\b|\bprd\b)\s*(?:不涉及|不查|排除)/i.test(text)||project?.analysisSourceMode!=='isolated')return current?[current]:[];
 const tiers=Object.keys(project.analysisEnvironments??{}).map(id=>[id,sourceRuntimeTier(project,id)]),selected=['uat','prd'].map(t=>tiers.filter(([id,tier])=>tier===t));
 if(selected.some(list=>list.length!==1))return current?[current]:[];
 return [...new Set([current,...selected.map(list=>list[0][0])].filter(Boolean))];
}
export function comparisonTarget(job,project,request){
 if(!request||typeof request.environmentId!=='string'||typeof request.reason!=='string'||!request.reason.trim())throw Error('源码环境接续需要明确已登记环境及调查目标');
 if(!requestedSourceEnvironments(job,project).includes(request.environmentId)||request.environmentId===job.sourceEnvironment)throw Object.assign(Error('源码环境不在用户原始双环境请求范围内，或已是当前环境'),{statusCode:403,code:'SOURCE_COMPARISON_SCOPE'});
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
