import {prepareSnapshotHistory} from './source-snapshot.js';

// The model requests a scoped metadata operation; only Runner can perform it.
// No shell paths, remotes or commits supplied by the model are executed.
export async function runWithSourceHistory(options,{run,history=prepareSnapshotHistory}={}){
 const {project,sourceSync,emit}=options,seen=new Set();let current={...options},lastHistory=options.job.analysisContinuation?.sourceHistory??null;
 for(;;){
  const result=await run(current),query=result.sourceHistoryQuery;
  if(!query)return {...result,...(lastHistory?{sourceHistory:lastHistory}:{})};
  if(options.job.taskIntent!=='analysis'||sourceSync?.policy!=='isolated-environment-source-v1'||!query||typeof query!=='object'||!Array.isArray(query.repositories)||!query.repositories.length||query.repositories.some(p=>!sourceSync.repositories.some(r=>r.path===p))||new Set(query.repositories).size!==query.repositories.length||typeof query.reason!=='string'||!query.reason.trim())throw new Error('源码历史请求不属于当前问题固定仓库范围');
  const legacyTargets=query.targets==null?[...new Set(query.reason.match(/\b[a-f0-9]{40,64}\b/g)??[])].filter(sha=>!sourceSync.repositories.some(r=>r.commit===sha)):[];
  const key=JSON.stringify([[...query.repositories].sort(),query.targets??null,legacyTargets]);
  if(seen.has(key))return {...result,sourceHistoryQuery:null,sourceHistory:lastHistory,outcome:'blocked',environmentQuery:null,websiteQuery:null,environmentSetup:null,summary:'相同历史请求没有新目标，已保留固定源码与历史结果，停止重复操作。',finalMessage:result.finalMessage+'\n\n相同历史请求已处理且没有新目标；请依据上次历史结果核对log/blame/show/diff，未切换提交。'};
  seen.add(key);
  await emit({type:'progress',phase:'source_history',message:'正在核对所选仓库历史目标，保持源码不变'});
  const targets=query.targets??[];
  if(!Array.isArray(targets)||targets.some(t=>!query.repositories.includes(t.repository)||!/^[a-f0-9]{40,64}$/.test(t.commit))||new Set(targets.map(t=>t.repository)).size!==targets.length)throw new Error('历史目标提交格式或仓库范围无效');
  const mismatched=targets.filter(t=>sourceSync.repositories.find(r=>r.path===t.repository)?.commit!==t.commit);
  // This tool hydrates the pinned commit's ancestors, not a different deployed
  // branch. Never spend a full unshallow fetch on an unrepresentable request.
  lastHistory=mismatched.length||legacyTargets.length?{policy:'pinned-source-ancestry-v1',environment:sourceSync.environment,repositories:query.repositories.map(p=>({path:p,status:'unavailable',code:legacyTargets.length?'SOURCE_HISTORY_TARGET_UNSPECIFIED':'SOURCE_HISTORY_TARGET_MISMATCH',reason:legacyTargets.length?'旧请求只在reason中给出不同SHA，目标含义不明确。请以targets结构字段明确是当前提交祖先还是另一生产版本；尚未下载，不丢弃当前源码证据。':'请求包含不同于当前固定源码的目标提交；祖先补取不会获取独立生产分支。没有执行下载或改动HEAD。',requestedCommit:targets.find(t=>t.repository===p)?.commit??null,pinnedCommit:sourceSync.repositories.find(r=>r.path===p)?.commit})),deploymentVerified:false}:await history(project,sourceSync,{repositories:query.repositories});
  await emit({type:'progress',phase:'source_history',message:lastHistory.repositories.every(r=>r.status==='complete')?'所选仓库历史已就绪，继续原会话调查':'部分历史不可用，保留当前源码证据并继续说明具体缺口',sourceContinuation:{...(result.artifactPolicy?{artifactPolicy:result.artifactPolicy}:{}),questionId:options.job.questionId,workspace:options.workspace,threadId:result.threadId,sourceHistory:lastHistory}});
  current={...current,resumeThreadIdOverride:result.threadId,job:{...current.job,context:[...(current.job.context??[]),{stage:current.job.stage,kind:'source_history',result:{...(result.artifactPolicy?{artifactPolicy:result.artifactPolicy}:{}),sourceSync,sourceHistory:lastHistory,threadId:result.threadId,workspace:options.workspace}}]},prompt:'Runner 已处理你请求的固定提交历史操作。以下是程序核验结果，不代表生产上线时间：\n'+JSON.stringify(lastHistory)+'\n请在同一只读会话继续原问题，使用log/blame/show/diff；完整历史可复用，失败原因须保留，不能把当前源码证据一并丢弃。不要重复相同历史请求；没有新目标时完成回答并把sourceHistoryQuery设为null。遵守原结果schema及权限。'};
 }
}
