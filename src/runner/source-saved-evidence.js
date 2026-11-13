import {sourceRuntimeTier} from '../shared/source-environments.js';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,lstat,realpath,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fingerprint,loadEnvironments,isEnvironmentOwner} from '../shared/environment-access.js';
import {assertTaskReadScope,loadIntegrationProjects} from '../shared/integration-peers.js';
import {priorToolResults} from '../shared/job-tool-results.js';
import {documentDirectory} from '../shared/document-artifacts.js';
import {ToolResultStore} from './tool-result-store.js';
import {TaskDatasetStore} from './task-dataset-store.js';
const digest=x=>createHash('sha256').update(x).digest('hex');
// The canonical writer stores a root `data` object. Hash that object's original
// JSON bytes without materialising its row array; only the small outer envelope
// is assembled. Restores preserve these canonical bytes, just like the old hash.
export async function datasetEnvelope(file){
 const hash=createHash('sha256');let depth=0,inString=false,escape=false,key='',readingKey=false,lastKey='',wantData=false,capturing=false,finished=false,outer='',captured=false;
 for await(const bytes of createReadStream(file)){
  let part=-1;
  for(let i=0;i<bytes.length;i++){
   const c=bytes[i];
   if(wantData&&!inString&&![9,10,13,32].includes(c)){if(c!==123)throw Error('Dataset data must be an object');wantData=false;capturing=true;captured=true;part=i;outer+='null';}
   if(inString){if(readingKey)key+=String.fromCharCode(c);if(escape)escape=false;else if(c===92)escape=true;else if(c===34){inString=false;if(readingKey){lastKey=JSON.parse('"'+key);readingKey=false;}}}
   else if(c===34){inString=true;escape=false;if(depth===1){readingKey=true;key='';}}
   else if(c===58&&depth===1&&lastKey==='data'&&!finished)wantData=true;
   else if(c===123||c===91)depth++;
   else if(c===125||c===93){depth--;if(depth<0)throw Error('Invalid dataset envelope');if(capturing&&depth===1){hash.update(bytes.subarray(part<0?0:part,i+1));part=-1;capturing=false;finished=true;continue;}}
   if(!capturing)outer+=String.fromCharCode(c);
  }
  if(capturing)hash.update(bytes.subarray(part<0?0:part));
 }
 if(!captured||capturing||inString||depth!==0)throw Error('Incomplete dataset envelope');
 // Metadata contains UTF-8 too; preserve its original byte values.
 const metadata=JSON.parse(Buffer.from(outer,'latin1').toString('utf8'));
 if(hash.digest('hex')!==(metadata.storage?.metadataHash??metadata.dataHash))throw Error('Dataset content digest mismatch');
 return metadata;
}
async function boundary(directory,file){const root=await realpath(directory),info=await lstat(file),actual=await realpath(file);if(info.isSymbolicLink()||!info.isFile()||path.dirname(actual)!==root)throw Error('Evidence file boundary changed');return {actual,bytes:info.size};}
export async function prepareSavedSourceEvidence(job,config,{load=loadEnvironments,projects:readProjects=()=>loadIntegrationProjects(config.projectsFile)}={}){
 if(job.taskIntent!=='analysis'||!job.id)return null;
 const cfg=await load(),projects=await readProjects();if(!job.sourceEnvironment)return null;const tier=sourceRuntimeTier(projects.projects?.[job.projectId]??config.projects?.[job.projectId],job.sourceEnvironment),allowed=new Map(),issues=[];
 const evidence=[...(job.context??[]).map(c=>c.result?.environmentEvidence),...(job.completedEnvironmentReads??[]).map(c=>({...c.plan,...c.result?.environmentEvidence}))];
 for(const v of evidence){const e=cfg.environments?.[v?.environmentId];if(!e||e.tier!==tier||!e.queries?.[v.queryId]||e.queries[v.queryId].mode!=='investigate'||v.configHash!==fingerprint(e))continue;
  if(v.projectId&&v.projectId!==e.projectId||v.requestingProjectId&&v.requestingProjectId!==job.projectId)continue;
  if(!e.membersRead&&!isEnvironmentOwner(e,{profile:job.originProfile??job.agentProfile,senderId:job.senderId}))continue;
  try{assertTaskReadScope(projects,job,cfg,{environmentId:v.environmentId,queryId:v.queryId});allowed.set(fingerprint(e),{environmentId:v.environmentId,queryId:v.queryId,projectId:e.projectId,tier:e.tier,configHash:fingerprint(e)});}catch{/* A revoked peer is not an attachment source. */}
 }
 if(!allowed.size)return null;
 const directory=await documentDirectory(config.dataDir??path.dirname(config.worktreeRoot),job.id),entries=[];
 const datasets=path.join(directory,'datasets');
 try{if((await lstat(datasets)).isSymbolicLink())throw Error('Linked dataset directory');for(const name of await readdir(datasets)){if(!/^dataset-[a-f0-9-]{36}\.json$/.test(name))continue;try{const p=await boundary(datasets,path.join(datasets,name)),m=await datasetEnvelope(p.actual),source=allowed.get(m.scope);if(!source||m.id+'.json'!==name||!Number.isFinite(Date.parse(m.readAt))||Date.parse(m.readAt)>Date.now()+1000)continue;
    // The existing reader checks each chunk's path, bytes, row count and digest
    // without assembling the full row array for chunked datasets.
    let parts;if(m.storage){const d=await new TaskDatasetStore(directory,m.scope).get(m.id,{metadataOnly:true,allowPartial:true});parts=d.storage.parts.map(x=>({...x,path:path.join(datasets,x.name)}));}
    entries.push({kind:'dataset',datasetRef:m.id,path:p.actual,bytes:p.bytes,dataHash:m.dataHash,readAt:m.readAt,source,format:parts?'rows-chunks-v1':'inline-json',...(parts?{parts}:{})});
   }catch(error){issues.push({kind:'dataset',ref:name.slice(0,-5),code:'SAVED_EVIDENCE_INVALID',reason:error.message});}}}catch(error){if(error.code!=='ENOENT')issues.push({kind:'dataset-directory',code:'SAVED_EVIDENCE_INVALID',reason:error.message});}
 const refs=priorToolResults(job,cfg,{projectId:job.projectId,tier});
 for(const [ref,provenance]of refs){if(!allowed.has(provenance.scope))continue;try{const store=new ToolResultStore({directory,scope:provenance.scope}),saved=await store.load(ref),p=await boundary(path.join(directory,'tool-results'),path.join(directory,'tool-results',ref+'.json'));entries.push({kind:'tool-result',resultRef:ref,tool:saved.tool,path:p.actual,bytes:p.bytes,sha256:saved.sha256,hashTarget:'UTF-8 envelope.text (not the envelope file)',envelopeSha256:digest(await readFile(p.actual)),readAt:saved.createdAt,source:allowed.get(provenance.scope),format:'json-text-envelope'});}catch(error){issues.push({kind:'tool-result',ref,code:'SAVED_EVIDENCE_INVALID',reason:error.message});}}
 // Recheck revocation at publication; never expose the private configuration.
 const current=await load(),freshProjects=await readProjects();for(const entry of entries){if(fingerprint(current.environments?.[entry.source.environmentId])!==entry.source.configHash)throw Error('Saved evidence authorization changed during handoff');assertTaskReadScope(freshProjects,job,current,entry.source);}
 if(!entries.length&&!issues.length)return null;
 const manifest={policy:'same-job-saved-source-evidence-v1',jobId:job.id,questionId:job.questionId,projectId:job.projectId,profile:job.originProfile??job.agentProfile,tier,entries,issues};
 const text=JSON.stringify(manifest),file=path.join(directory,'source-evidence-'+digest(text)+'.json');try{await writeFile(file,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 return {path:file,sha256:digest(text),entries:entries.length,issues:issues.length};
}
export function savedSourceEvidenceNotice(evidence){return evidence?`\n本任务已保存的原始证据可直接只读核查，不需要重新查询环境，也不需要不存在的模型工具。先读取证据索引 ${evidence.path}（SHA256 ${evidence.sha256}）。索引仅包含本job、原系统/环境当前仍获准且实际路径与摘要验证通过的文件：inline-json数据集的完整列和行在JSON的data.columns/data.rows；rows-chunks-v1的列在原清单data.columns，行在索引parts[].path，每片已有独立摘要；json-text-envelope工具结果先JSON.parse外层，再JSON.parse其中text字符串；sha256核验UTF-8的text正文，envelopeSha256核验整个封装文件，两种摘要不能交叉比较。用当前只读源码工具读取这些真实路径，按需要程序化筛选/分页；不要把目录引用当作空结果，也不要再请求环境重复抄录同一批值。保留source/readAt及partial/complete，不把跨轮结果冒称同一事务快照；源数据存在不等于独立业务核验已通过。无权、损坏文件不会列入可用entries，issues仅说明真实缺项。引用证据时使用datasetRef/resultRef和摘要；不要把这些原始文件绝对路径填入handoff.artifacts。最终文档仍用documentRequests生成。此索引不是跨job共享目录或新数据库权限。\n`:'';}
