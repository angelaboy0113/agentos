import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,lstat,realpath,writeFile,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {git} from './source-sync.js';
import {verifySnapshot} from './source-snapshot.js';
import {verifyIndependentGit,independentGitEnvironment} from '../shared/git-metadata.js';
import {documentDirectory} from '../shared/document-artifacts.js';
import {cleanWebsiteText} from '../shared/website-policy.js';
const fail=(code)=>Object.assign(new Error(code),{code});
// Reuse the repository's existing credential helper in get/fill mode only.
// Credentials never enter an artifact, error, URL or model-visible return value.
export async function sourceReadCredential(cwd,origin){
 const u=new URL(origin);return new Promise((resolve,reject)=>{
  const child=spawn('git',['-c','core.hooksPath=/dev/null','-C',cwd,'credential','fill'],{env:{...independentGitEnvironment(),GCM_INTERACTIVE:'never'},stdio:['pipe','pipe','ignore']});let out='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE'));},120000);
  child.stdout.on('data',chunk=>{out+=chunk;if(Buffer.byteLength(out)>65536){child.kill('SIGTERM');finish(fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE'));}});
  child.on('error',()=>finish(fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE')));child.on('close',code=>{const password=/^password=(.+)$/m.exec(out)?.[1];finish(code||!password?fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE'):null,password);});
  child.stdin.on('error',()=>{});child.stdin.end('protocol=https\nhost='+u.host+'\npath='+u.pathname.slice(1).replace(/\.git$/,'')+'\n\n');
 });
}
export async function prepareSourceCommitMetadata(project,sync,query,{job,dataDir,run=git,verify=verifySnapshot,credential=sourceReadCredential,fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(job?.taskIntent!=='analysis'||sync?.policy!=='isolated-environment-source-v1'||query?.operation!=='commit_metadata'||!Array.isArray(query.repositories)||!query.repositories.length||new Set(query.repositories).size!==query.repositories.length||query.repositories.some(p=>!sync.repositories.some(r=>r.path===p))||!/^[a-f0-9]{7,64}$/i.test(query.commit??'')||typeof query.reason!=='string'||!query.reason.trim())throw fail('SOURCE_METADATA_SCOPE');
 await verify(project,sync);const rows=[];
 for(const repository of query.repositories){
  const pinned=sync.repositories.find(r=>r.path===repository),cwd=path.resolve(sync.workspace,repository);await verifyIndependentGit(cwd);const origin=await run(cwd,['remote','get-url','origin']);let u;
  try{u=new URL(origin);}catch{rows.push({repository,status:'unsupported-provider'});continue;}
  if(u.origin!=='https://cnb.cool'||u.username||u.password||u.search||u.hash||!/^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(u.pathname)||u.pathname.split('/').some(p=>p==='.'||p==='..')){rows.push({repository,status:'unsupported-provider'});continue;}
  const slug=u.pathname.slice(1).replace(/\.git$/,'');let secret;
  try{secret=await credential(cwd,origin);if(typeof secret!=='string'||!secret)throw fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE');}catch{rows.push({repository,status:'unavailable',code:'SOURCE_METADATA_CREDENTIAL_UNAVAILABLE'});continue;}
  const clean=value=>cleanWebsiteText(String(value??'').split(secret).join('[redacted]'),20000);
  const person=p=>({name:clean(p?.name),email:clean(p?.email),date:clean(p?.date)});
  async function get(route){let response;for(let attempt=0;attempt<3;attempt++){try{response=await fetcher('https://api.cnb.cool/'+slug+'/-/git/'+route,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+secret,Accept:'application/vnd.cnb.api+json'},signal:AbortSignal.timeout(600000)});}catch{if(attempt===2)throw fail('SOURCE_METADATA_NETWORK');await pause(1000*(attempt+1));continue;}if([429,502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel();await pause(1000*(attempt+1));continue;}break;}
   if(response.status!==200){await response.body?.cancel();throw fail(response.status===404?'SOURCE_METADATA_NOT_FOUND':response.status===401?'SOURCE_METADATA_AUTH':response.status===403?'SOURCE_METADATA_PERMISSION':'SOURCE_METADATA_HTTP_'+response.status);}
   const chunks=[];let bytes=0;const reader=response.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024)throw fail('SOURCE_METADATA_RESPONSE_SIZE');chunks.push(value);}}finally{await reader.cancel();}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('SOURCE_METADATA_RESPONSE');}
  }
  try{
   const b=await get('commits/'+query.commit.toLowerCase());if(!/^[a-f0-9]{40,64}$/i.test(b.sha??'')||!b.sha.toLowerCase().startsWith(query.commit.toLowerCase())||!b.commit?.author||!b.commit?.committer||!Array.isArray(b.parents)||b.parents.some(p=>!/^[a-f0-9]{40,64}$/i.test(p.sha??'')))throw fail('SOURCE_METADATA_IDENTITY');
   const row={repository,status:'found',commit:b.sha,pinnedCommit:pinned.commit,author:person(b.commit.author),committer:person(b.commit.committer),message:clean(b.commit.message),parents:b.parents.map(p=>p.sha),platformAuthor:{username:clean(b.author?.username),nickname:clean(b.author?.nickname)},platformMergeActorVerified:false};
   try{const c=await get('compare/'+b.sha+'...'+pinned.commit);if(c.base_commit?.sha!==b.sha||c.head_commit?.sha!==pinned.commit||!/^[a-f0-9]{40,64}$/i.test(c.merge_base_commit?.sha??''))throw fail('SOURCE_METADATA_COMPARE_IDENTITY');row.pinnedAncestry={status:'verified',mergeBase:c.merge_base_commit.sha,targetIsAncestorOfPinned:c.merge_base_commit.sha===b.sha};}catch(error){row.pinnedAncestry={status:'unavailable',code:error.code??'SOURCE_METADATA_COMPARE_UNAVAILABLE'};}
   rows.push(row);
  }catch(error){rows.push({repository,status:error.code==='SOURCE_METADATA_NOT_FOUND'?'not-found':'unavailable',code:error.code??'SOURCE_METADATA_UNAVAILABLE'});}
 }
 const binding={jobId:job.id,questionId:job.questionId,profile:job.originProfile??job.agentProfile,projectId:job.projectId,environment:sync.environment,originalCacheKey:sync.cacheKey,repositories:query.repositories.map(p=>sync.repositories.find(r=>r.path===p)).map(r=>({repository:r.path,branch:r.branch,commit:r.commit}))};
 const report={policy:'source-commit-metadata-v1',operation:'commit_metadata',binding,requestedCommit:query.commit,checkedAt:new Date().toISOString(),rows,environmentSnapshotUnchanged:true,deploymentVerified:false,note:'Commit metadata and comparison only. Not a complete Git history or proof of who clicked merge, deployment time or current production version. A 404 applies only to this repository and query; failed sources are not negative evidence.'};
 const dir=path.join(await documentDirectory(dataDir,job.id),'source-metadata');await mkdir(dir,{recursive:true,mode:0o700});const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(dir)!==dir)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');const file=randomUUID()+'.json';await writeFile(path.join(dir,file),JSON.stringify(report),{mode:0o600,flag:'wx'});return{...report,artifact:'source-metadata/'+file,resultHash:createHash('sha256').update(JSON.stringify(report)).digest('hex')};
}

export async function sourceCommitMetadataArtifact(dataDir,job,relative){
 if(!/^source-metadata\/[a-f0-9-]{36}\.json$/.test(relative??''))throw fail('SOURCE_METADATA_ARTIFACT_PATH');
 const scope=job.sourceReferenceScope,proof=[...(job.context??[]).map(c=>c.result?.sourceHistory),job.analysisContinuation?.sourceHistory].find(p=>p?.policy==='source-commit-metadata-v1'&&p.artifact===relative);
 if(scope?.policy!=='isolated-environment-source-v1'||!proof||proof.binding?.jobId!==job.id||proof.binding.questionId!==job.questionId||proof.binding.profile!==(job.originProfile??job.agentProfile)||proof.binding.projectId!==job.projectId||proof.binding.environment!==scope.environment||proof.binding.originalCacheKey!==scope.cacheKey||proof.binding.repositories.some(r=>!scope.repositories.some(x=>x.path===r.repository&&x.branch===r.branch&&x.commit===r.commit)))throw fail('SOURCE_METADATA_ARTIFACT_SCOPE');
 const root=await documentDirectory(dataDir,job.id),dir=path.join(root,'source-metadata'),file=path.join(root,relative);for(const p of [dir,file]){const s=await lstat(p);if(s.isSymbolicLink()||await realpath(p)!==p||s.isFile()&&s.nlink!==1)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');}
 const bytes=await readFile(file),sha256=createHash('sha256').update(bytes).digest('hex');if(sha256!==proof.resultHash)throw fail('SOURCE_METADATA_ARTIFACT_CHANGED');return{file,bytes:bytes.length,sha256,binding:proof.binding,deploymentVerified:false};
}
