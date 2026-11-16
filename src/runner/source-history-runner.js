import {prepareSourceCommitMetadata} from './source-commit-metadata.js';
import {prepareSourceReference} from './source-reference.js';
import {prepareSnapshotHistory} from './source-snapshot.js';

// The model requests a scoped metadata operation; only Runner can perform it.
// No shell paths, remotes or commits supplied by the model are executed.
export async function runWithSourceHistory(options,{run,history=prepareSnapshotHistory,reference=prepareSourceReference,metadata=prepareSourceCommitMetadata}={}){
 const {project,sourceSync,emit}=options,seen=new Set(),sourceEvidenceReceipts=[];let current={...options},lastHistory=options.job.analysisContinuation?.sourceHistory??null;
 // Only runner-produced receipts cross the final handoff boundary; model output cannot supply them.
 const finish=result=>({...result,sourceHistory:lastHistory,sourceEvidenceReceipts});
 for(;;){
  const result=await run(current),query=result.sourceHistoryQuery;
  if(!query)return finish(result);
  if(query.operation){
   const key=JSON.stringify([query.operation,query.repository,query.branch??null,query.commit??null,query.repositories??null]);
   if(seen.has(key))return finish({...result,sourceHistoryQuery:null,outcome:'partial',finalMessage:result.finalMessage+'\n相同源码对照请求已处理，保留原证据，不重复下载。'});
   seen.add(key);
   try{lastHistory=await (query.operation==='commit_metadata'?metadata:reference)(project,sourceSync,query,{job:options.job,dataDir:options.config.dataDir});}
   catch(error){lastHistory={policy:'separate-source-reference-v1',operation:query.operation,repository:query.repository,repositories:query.repositories,branch:query.branch??null,commit:query.commit??null,status:'unavailable',code:error.code??'SOURCE_REFERENCE_UNAVAILABLE',deploymentVerified:false,environmentSnapshotUnchanged:true};}
   if(lastHistory?.policy==='source-commit-metadata-v1')sourceEvidenceReceipts.push(lastHistory);
   await emit({type:'progress',phase:'source_reference',message:query.operation==='commit_metadata'?'已核对提交元数据及固定分支关系，未下载完整历史':'已核对独立分支参考，原环境源码保持不变',sourceContinuation:{questionId:options.job.questionId,workspace:options.workspace,threadId:result.threadId,sourceHistory:lastHistory}});
   current={...current,resumeThreadIdOverride:result.threadId,job:{...current.job,context:[...(current.job.context??[]),{stage:current.job.stage,kind:'source_reference',result:{sourceSync,sourceHistory:lastHistory,threadId:result.threadId,workspace:options.workspace}}]},prompt:(query.operation==='commit_metadata'?'提交身份快速核对结果：只按原题解释作者、提交者与固定环境包含关系；平台合并操作者尚未核验不得冒认。可用kind:code及返回artifact引用这份任务专属元数据证据。无需为了重复这份信息再下载整仓历史。\n':'')+'Runner已处理独立源码参考请求（history.status说明祖先是否完整）：'+JSON.stringify(lastHistory)+'\n继续原问题。参考目录只作标明分支和固定SHA的对照，不是生产版本或当前环境替代。原sourceSync、身份、环境、HEAD保持。先解释已核实逻辑和静态调用，生产是否采用仍用既有部署/构建工具核对；运行次数不能从静态入口数推断。失败保留具体code和已有证据，不重复同请求。遵守原结果schema，无需请求时sourceHistoryQuery=null。'};
   continue;
  }
  if(options.job.taskIntent!=='analysis'||sourceSync?.policy!=='isolated-environment-source-v1'||!query||typeof query!=='object'||!Array.isArray(query.repositories)||!query.repositories.length||query.repositories.some(p=>!sourceSync.repositories.some(r=>r.path===p))||new Set(query.repositories).size!==query.repositories.length||typeof query.reason!=='string'||!query.reason.trim())throw new Error('源码历史请求不属于当前问题固定仓库范围');
  const legacyTargets=query.targets==null?[...new Set(query.reason.match(/\b[a-f0-9]{40,64}\b/g)??[])].filter(sha=>!sourceSync.repositories.some(r=>r.commit===sha)):[];
  const key=JSON.stringify([[...query.repositories].sort(),query.targets??null,legacyTargets]);
  if(seen.has(key))return finish({...result,sourceHistoryQuery:null,outcome:'blocked',environmentQuery:null,websiteQuery:null,environmentSetup:null,summary:'相同历史请求没有新目标，已保留固定源码与历史结果，停止重复操作。',finalMessage:result.finalMessage+'\n\n相同历史请求已处理且没有新目标；请依据上次历史结果核对log/blame/show/diff，未切换提交。'});
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
