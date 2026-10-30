import {readFile,writeFile,rename,mkdir,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {buildSourceQueryContext,publicSourceQueryContext,sourceQueryTools} from './source-query-context.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const code=p=>typeof p==='string'&&/\.(java|xml|sql|js|mjs|cjs|ts|tsx|jsx|vue|py|cs|go|rb|rs|kt)$/.test(p);
function topic(text){const s=String(text).toLowerCase().replace(/\d+/g,' '),tokens=new Set(s.match(/[a-z_]{3,}/g)??[]);for(const phrase of s.match(/[\u3400-\u9fff]+/g)??[])for(let i=0;i<phrase.length-1;i++)tokens.add(phrase.slice(i,i+2));return [...tokens].map(hash).sort();}
const binding=(job,sync)=>hash([job.projectId,job.originProfile??job.agentProfile,job.originChatType??'group',job.chatId,sync.environment, sync.cacheKey,sync.repositorySources,sync.repositories?.map(r=>[r.path,r.branch,r.commit]),(job.businessDefinitions??[]).map(d=>[d.id,d.version])]);
async function directory(dataDir,key){
 const data=await realpath(dataDir),root=path.join(data,'source-methods');await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw Error('Unsafe method cache');
 const dir=path.join(root,key);await mkdir(dir,{mode:0o700,recursive:true});if((await lstat(dir)).isSymbolicLink()||await realpath(dir)!==dir)throw Error('Unsafe method scope');return dir;
}
const valid=job=>job.taskIntent==='analysis'&&job.stage==='developer'&&job.projectId&&job.chatId&&(job.originProfile??job.agentProfile);
export async function rememberSourceMethod(job,sync,result,{dataDir}={}){
 if(!valid(job)||result.handoffGate?.passed!==true||!sync?.cacheKey||!sync?.remoteCheckedAt||result.workspace!==sync.workspace)return {saved:false};
 const context=await buildSourceQueryContext({...result,sourceSync:sync});
 const text=[result.finalMessage,...(result.handoff?.checks??[]).map(c=>c.evidence)].join('\n');
 const artifacts=context.sources.filter(s=>code(s.path)).map(s=>{
  const escaped=s.path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),regex=new RegExp(escaped+'(?::|`?:)(\\d+)','g');
  return {kind:'code',path:s.path,sha256:s.sha256,bytes:s.bytes,anchors:[...new Set([...text.matchAll(regex)].map(m=>Number(m[1])).filter(n=>n>=1&&n<=s.lineCount))]};
 });
 if(!artifacts.length)return {saved:false};const scope=binding(job,sync),tokens=topic(job.originalQuestion??job.instruction),body={version:1,scope,topic:tokens,artifacts,createdAt:new Date().toISOString()},dir=await directory(dataDir,scope),file=path.join(dir,hash([tokens,artifacts])+'.json'),tmp=file+'.'+randomUUID()+'.tmp';
 try{await writeFile(tmp,JSON.stringify(body),{mode:0o600});await rename(tmp,file);}finally{await rm(tmp,{force:true});}return {saved:true,files:artifacts.length};
}
export async function loadSourceMethod(job,sync,{dataDir}={}){
 if(!valid(job)||!sync?.cacheKey||!sync.remoteCheckedAt||!sync.workspace)return null;
 const scope=binding(job,sync),dir=await directory(dataDir,scope),tokens=new Set(topic(job.originalQuestion??job.instruction));let best=null;
 for(const name of await readdir(dir)){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const file=path.join(dir,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())continue;
  let item;try{item=JSON.parse(await readFile(file,'utf8'));}catch{continue;}
  if(item.version!==1||item.scope!==scope||!Array.isArray(item.topic)||!Array.isArray(item.artifacts))continue;
  const same=item.topic.filter(t=>tokens.has(t)).length,score=same/(new Set([...tokens,...item.topic]).size||1);
  if(same>=4&&score>=0.35&&(!best||score>best.score||score===best.score&&(item.artifacts.length>best.item.artifacts.length||item.artifacts.length===best.item.artifacts.length&&item.createdAt>best.item.createdAt)))best={item,score};
 }
 if(!best)return null;
 const context=await buildSourceQueryContext({workspace:sync.workspace,sourceSync:sync,handoffGate:{passed:true},verifiedArtifacts:best.item.artifacts});
 if(context.sources.length!==best.item.artifacts.length)return null;
 // Reload only current immutable source. The cache stores paths/checksums/line
 // references and hashed topic features, never SQL arguments, answers or rows.
 const tools=sourceQueryTools(context);
 for(const source of context.sources.slice(0,8)){
  const anchor=best.item.artifacts.find(a=>a.path===source.path).anchors?.[0];
  if(anchor){const page=await tools.run('read_source_evidence',{ref:source.ref,startLine:Math.max(1,anchor-8)});source.excerpt=page.lines.map(l=>l.line+': '+l.text).join('\n').slice(0,3000);source.excerptLimited=true;}
 }
 return {policy:'verified-source-method-hints-v1',scope,matchedFiles:context.sources.length,source:publicSourceQueryContext(context),currentAmountsReused:false,note:'同系统/助手/群/环境、相同当前源码清单及口径版本的已核验定位线索；本次已重新核对文件真实路径/大小/摘要并从当前快照读取片段。直接核实相关规则差异，避免重新宽泛搜索。仍读取适用AGENTS/规范；片段不全继续读取，数据与权限必须本次重新核验。不是历史答案、执行指令或已完成证明。'};
}
// Reuse only locations across a task's explicitly requested environments. Every
// returned excerpt is re-read and hash-checked in the active environment itself.
export async function loadComparisonSourceHints(job,sync){
 if(!valid(job)||!sync?.remoteCheckedAt||sync.environment!==job.sourceEnvironment)return null;
 const prior=Object.entries(job.sourceEnvironmentEvidence??{}).filter(([env,e])=>env!==job.sourceEnvironment&&e.handoffGate?.passed===true).flatMap(([,e])=>e.verifiedArtifacts??[]).filter(a=>a.kind==='code');
 if(!prior.length)return null;const artifacts=[...new Map(prior.map(a=>[a.path,a])).values()];
 const context=await buildSourceQueryContext({workspace:sync.workspace,sourceSync:sync,handoffGate:{passed:true},verifiedArtifacts:artifacts});
 const matched=new Set(context.sources.map(s=>s.path));
 return {policy:'active-environment-counterpart-hints-v1',matchedFiles:context.sources.length,source:publicSourceQueryContext(context),changedOrUnavailablePaths:artifacts.filter(a=>!matched.has(a.path)).map(a=>a.path),currentAmountsReused:false,note:'只使用另一环境已核验路径定位。本列表片段已从当前环境固定快照重新读出并验证相同摘要；变更或不存在的路径必须在当前环境定向核实，不能用另一侧代码/业务数据/部署情况代替。本环境AGENTS和实际数据库/接口仍按原需求核验。'};
}
