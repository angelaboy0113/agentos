import path from 'node:path';
import {mkdir,lstat,realpath,writeFile,readFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {git} from './source-sync.js';
import {verifySnapshot} from './source-snapshot.js';
import {verifyIndependentGit} from '../shared/git-metadata.js';
import {documentDirectory} from '../shared/document-artifacts.js';
import {cleanWebsiteText} from '../shared/website-policy.js';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import {sourceReadCredential} from './source-commit-metadata.js';
const fail=code=>Object.assign(new Error(code),{code}),sha=/^[a-f0-9]{40,64}$/;
const timestamp=x=>x===null||typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
// Read-only metadata, not a partial clone: no fetch, checkout, worktree or shared
// object store. Each repository resolves its branch once and pages that exact SHA.
async function prepareBranchCommits(project,sync,query,{job,dataDir,run=git,verify=verifySnapshot,credential=sourceReadCredential,fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),saved,heads={},saveHead=async()=>{},emit=async()=>{}}={}){
 if(job?.taskIntent!=='analysis'||sync?.policy!=='isolated-environment-source-v1'||query.operation!=='branch_commits'||!Array.isArray(query.repositories)||!query.repositories.length||new Set(query.repositories).size!==query.repositories.length||query.repositories.some(p=>!sync.repositories.some(r=>r.path===p))||typeof query.branch!=='string'||!query.branch||query.branch.startsWith('-')||typeof query.reason!=='string'||!query.reason.trim()||!timestamp(query.since)||!timestamp(query.until)||query.since&&query.until&&Date.parse(query.since)>Date.parse(query.until))throw fail('SOURCE_BRANCH_METADATA_SCOPE');
 await verify(project,sync);
 const rows=new Array(query.repositories.length);let next=0;
 async function readRepository(repository){
  const pinned=sync.repositories.find(r=>r.path===repository),cwd=path.resolve(sync.workspace,repository);
  await verifyIndependentGit(cwd);await run(cwd,['check-ref-format','refs/heads/'+query.branch]);
  const origin=await run(cwd,['remote','get-url','origin']);let u;
  try{u=new URL(origin);}catch{return{repository,status:'unsupported-provider'};}
  if(u.origin!=='https://cnb.cool'||u.username||u.password||u.search||u.hash||!/^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(u.pathname)||u.pathname.split('/').some(p=>p==='.'||p==='..'))return{repository,status:'unsupported-provider'};
  const prior=saved?.rows?.find(r=>r.repository===repository);
  if(prior?.complete&&prior.originHash===createHash('sha256').update(origin).digest('hex'))return prior;
  const originHash=createHash('sha256').update(origin).digest('hex'),headKey=createHash('sha256').update(JSON.stringify([repository,query.branch,originHash])).digest('hex'),fixed=heads[headKey]??(prior?.originHash===originHash?prior.commit:null);
  if(fixed&&!sha.test(fixed))throw fail('SOURCE_BRANCH_METADATA_IDENTITY');
  const raw=fixed?fixed+'\trefs/heads/'+query.branch:await run(cwd,['ls-remote','--heads','origin','refs/heads/'+query.branch]);
  const refs=raw.split('\n').filter(Boolean).map(l=>l.split(/\s+/));
  if(refs.length===0)return{repository,status:'branch-not-found',branch:query.branch,checkedAt:new Date().toISOString()};
  if(refs.length!==1||!sha.test(refs[0][0])||refs[0][1]!=='refs/heads/'+query.branch)throw fail('SOURCE_BRANCH_METADATA_IDENTITY');
  const head=refs[0][0];if(!heads[headKey]){heads[headKey]=head;await saveHead();}
  const row={repository,status:'partial',branch:query.branch,commit:head,pinnedCommit:pinned.commit,checkedAt:new Date().toISOString(),commits:[],pages:0,complete:false,platformMergeActorVerified:false,originHash:createHash('sha256').update(origin).digest('hex')};
  let secret;
  try{secret=await credential(cwd,origin);if(typeof secret!=='string'||!secret)throw fail('SOURCE_METADATA_CREDENTIAL_UNAVAILABLE');}catch{return{...row,status:'unavailable',code:'SOURCE_METADATA_CREDENTIAL_UNAVAILABLE'};}
  const clean=v=>cleanWebsiteText(String(v??'').split(secret).join('[redacted]'),20000),person=p=>({name:clean(p?.name),email:clean(p?.email),date:clean(p?.date)}),seen=new Set();
  const params=new URLSearchParams({sha:head,page_size:'100'});if(query.since)params.set('since',query.since);if(query.until)params.set('until',query.until);
  try{
   for(let page=1;;page++){
    params.set('page',String(page));let response;
    for(let attempt=0;attempt<3;attempt++){
     try{response=await fetcher('https://api.cnb.cool/'+u.pathname.slice(1).replace(/\.git$/,'')+'/-/git/commits?'+params,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+secret,Accept:'application/vnd.cnb.api+json'},signal:AbortSignal.timeout(600000)});}
     catch{if(attempt===2)throw fail('SOURCE_METADATA_NETWORK');await pause(1000*(attempt+1));continue;}
     if([429,502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel();await pause(1000*(attempt+1));continue;}break;
    }
    if(response.status!==200){await response.body?.cancel();throw fail(response.status===401?'SOURCE_METADATA_AUTH':response.status===403?'SOURCE_METADATA_PERMISSION':response.status===404?'SOURCE_METADATA_NOT_FOUND':'SOURCE_METADATA_HTTP_'+response.status);}
    const chunks=[];let bytes=0;const reader=response.body.getReader();try{for(;;){const{done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024)throw fail('SOURCE_METADATA_RESPONSE_SIZE');chunks.push(value);}}finally{await reader.cancel();}
    let values;try{values=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('SOURCE_METADATA_RESPONSE');}
    if(!Array.isArray(values)||values.length>100)throw fail('SOURCE_BRANCH_METADATA_PAGINATION');
    // An empty terminating page is required even after a short page. Failed or
    // repeated pages never establish a complete/empty branch history.
    if(!values.length){row.pages=page;break;}
    const batch=[];
    for(const c of values){
     if(!sha.test(c.sha??'')||seen.has(c.sha)||!c.commit?.author||!c.commit?.committer||!Array.isArray(c.parents)||c.parents.some(p=>!sha.test(p.sha??'')))throw fail('SOURCE_BRANCH_METADATA_PAGINATION');
     seen.add(c.sha);batch.push({commit:c.sha,parents:c.parents.map(p=>p.sha),author:person(c.commit.author),committer:person(c.commit.committer),message:clean(c.commit.message),gitMerge:c.parents.length>1,platformMergeActorVerified:false});
    }
    row.commits.push(...batch);row.pages=page;
   }
   if(!query.since&&!query.until&&(!seen.has(head)||row.commits.some(c=>c.parents.some(p=>!seen.has(p)))))throw fail('SOURCE_BRANCH_METADATA_INCOMPLETE_GRAPH');
   if(!query.since&&!query.until){const byId=new Map(row.commits.map(c=>[c.commit,c])),reachable=new Set(),pending=[head];while(pending.length){const id=pending.pop();if(reachable.has(id))continue;reachable.add(id);pending.push(...byId.get(id).parents);}if(reachable.size!==seen.size)throw fail('SOURCE_BRANCH_METADATA_INCOMPLETE_GRAPH');}
   row.complete=true;row.status='complete';row.historyScope=query.since||query.until?'explicit-time-filter':'all-reachable-commits';
  }catch(e){row.code=e.code??'SOURCE_METADATA_UNAVAILABLE';row.status=row.commits.length?'partial':'unavailable';}
  return row;
 }
 // Bound active I/O rather than the number of repositories, pages or task time.
 await Promise.all(Array.from({length:Math.min(4,query.repositories.length)},async()=>{for(;;){const i=next++;if(i>=query.repositories.length)return;try{rows[i]=await readRepository(query.repositories[i]);}catch(e){rows[i]={repository:query.repositories[i],status:'unavailable',code:e.code??'SOURCE_METADATA_UNAVAILABLE',complete:false};}await emit({type:'progress',phase:'source_branch_metadata',message:query.repositories[i]+'：分支提交元数据 '+rows[i].status,sourceMetadataProgress:{repository:query.repositories[i],status:rows[i].status,completed:rows.filter(Boolean).length,total:rows.length}});}}));
 await verify(project,sync);
 const binding={jobId:job.id,questionId:job.questionId,profile:job.originProfile??job.agentProfile,projectId:job.projectId,environment:sync.environment,originalCacheKey:sync.cacheKey,repositories:query.repositories.map(p=>sync.repositories.find(r=>r.path===p)).map(r=>({repository:r.path,branch:r.branch,commit:r.commit}))};
 const report={policy:'source-commit-metadata-v1',operation:'branch_commits',binding,branch:query.branch,since:query.since,until:query.until,checkedAt:new Date().toISOString(),rows,environmentSnapshotUnchanged:true,deploymentVerified:false,note:'Git parent relationships, authors and committers only. Not platform merge operators/times, formal requirement ownership or deployment evidence. Per-repository failures retain valid pages and never mean zero commits.'};
 const dir=path.join(await documentDirectory(dataDir,job.id),'source-metadata');await mkdir(dir,{recursive:true,mode:0o700});const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(dir)!==dir)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');
 const content=JSON.stringify(report);
 return{report,content};
}
export async function prepareSourceBranchCommits(project,sync,query,options={}){
 // Use the task-owned artifact namespace; scope validation below precedes credentials and network.
 if(!options.job?.id||!options.job?.questionId)throw fail('SOURCE_BRANCH_METADATA_SCOPE');
 const dir=path.join(await documentDirectory(options.dataDir,options.job.id),'source-metadata');await mkdir(dir,{recursive:true,mode:0o700});
 if(!(await lstat(dir)).isDirectory()||await realpath(dir)!==dir)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');
 const identity={jobId:options.job.id,questionId:options.job.questionId,profile:options.job.originProfile??options.job.agentProfile,projectId:options.job.projectId,environment:sync?.environment,cacheKey:sync?.cacheKey,repositories:query.repositories,branch:query.branch,since:query.since,until:query.until};
 const key=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32),name=key.slice(0,8)+'-'+key.slice(8,12)+'-'+key.slice(12,16)+'-'+key.slice(16,20)+'-'+key.slice(20)+'.json',file=path.join(dir,name);
 return withSnapshotLock(dir,async()=>{
  let saved;try{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||await realpath(file)!==file)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');saved=JSON.parse(await readFile(file,'utf8'));if(JSON.stringify(saved.queryIdentity)!==JSON.stringify(identity))throw fail('SOURCE_METADATA_ARTIFACT_SCOPE');}catch(e){if(e.code!=='ENOENT')throw e;}
  const headIdentity={...identity};for(const k of ['repositories','branch','since','until'])delete headIdentity[k];
  const headFile=path.join(dir,'branch-heads-'+createHash('sha256').update(JSON.stringify(headIdentity)).digest('hex')+'.json');let heads={};
  try{const st=await lstat(headFile);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||await realpath(headFile)!==headFile)throw fail('SOURCE_METADATA_ARTIFACT_BOUNDARY');heads=JSON.parse(await readFile(headFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const saveHead=async()=>{const temp=headFile+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(heads),{mode:0o600,flag:'wx'});await rename(temp,headFile);};
  const{report}=await prepareBranchCommits(project,sync,query,{...options,saved,heads,saveHead});report.queryIdentity=identity;
  const content=JSON.stringify(report),artifactName=randomUUID()+'.json',temp=file+'.'+randomUUID()+'.tmp';await writeFile(path.join(dir,artifactName),content,{mode:0o600,flag:'wx'});await writeFile(temp,content,{mode:0o600,flag:'wx'});await rename(temp,file);
  return{...report,rows:report.rows.map(({commits=[],...r})=>({...r,commitCount:commits.length,mergeCommitCount:commits.filter(c=>c.gitMerge).length})),artifact:'source-metadata/'+artifactName,resultHash:createHash('sha256').update(content).digest('hex'),recordsInArtifact:true};
 });
}
