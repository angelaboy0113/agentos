import { canonicalWebsite } from '../shared/website-aliases.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { environmentFile, loadEnvironments, planQuery, verifyApprovedPlan } from '../shared/environment-access.js';
import { websiteUrl, websiteKey } from '../shared/website-policy.js';
let updates=Promise.resolve();
const polling=new WeakMap();
export function prepareWebsiteQuery(context,job,request){
 const pending=updates.then(async()=>{
  if(!request||!['uat','prd'].includes(request.tier)||typeof request.purpose!=='string'||!request.purpose.trim()||request.purpose.length>200)throw new Error('网页排查需要明确环境、目的和发现的入口');
  if(job.sourceEnvironment&&job.sourceEnvironment!==request.tier)throw new Error('网页环境必须与本问题环境一致');
  const cfg=await loadEnvironments();
  const baseUrl=canonicalWebsite(cfg,job.projectId,request.tier,request.url),environmentId=websiteKey(job.projectId,request.tier,baseUrl);
  if(cfg.environments[environmentId] && websiteUrl(cfg.environments[environmentId].baseUrl)!==baseUrl)throw new Error('网页入口登记冲突，未复用其他页面');
  if(!cfg.environments[environmentId]){
   const owners=context.projects.ownerOpenIdsByProfile??{};
   if(!(owners[job.originProfile]??[]).length)throw new Error('本项目没有配置管理员身份');
   cfg.environments[environmentId]={projectId:job.projectId,tier:request.tier,kind:'website',baseUrl,credentialRef:environmentId,ownerOpenIdsByProfile:owners,membersRead:request.tier==='uat',queries:{investigate:{mode:'investigate',reviewed:true,description:'按原问题查看业务网页、查询与日志；不执行修改、启动或停止',maxRows:20,timeoutMs:10000,parameters:[{name:'purpose',type:'string',maxLength:200}],browser:true}}};
   const file=environmentFile();await mkdir(path.dirname(file),{recursive:true});const temp=file+'.website.tmp';await writeFile(temp,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});await rename(temp,file);
  }
  return {environmentId,queryId:'investigate',parameters:[request.purpose]};
 });updates=pending.catch(()=>{});return pending;
}
export function pollWebsiteLogins(context){
 if(polling.has(context))return polling.get(context);
 const run=resumeWebsiteLogins(context).finally(()=>polling.delete(context));polling.set(context,run);return run;
}
async function resumeWebsiteLogins(context){
 const jobs=(await context.store.read()).jobs.filter(j=>j.status==='awaiting_clarification'&&j.result?.browserLoginRequired===true&&j.environmentAccess?.kind==='website');
 for(const job of jobs){
  try{
   const cfg=await loadEnvironments(),e=cfg.environments[job.environmentAccess.environmentId];if(!e)continue;
   if(!await context.websiteBrowser.loginReady(job,e))continue;
   await context.store.transact(state=>{
    const current=state.jobs.find(j=>j.id===job.id);if(current?.status!=='awaiting_clarification'||!current.result?.browserLoginRequired)return;
    let valid=true;try{verifyApprovedPlan(cfg,current.environmentAccess);}catch{valid=false;}
    current.browserCheckpoint=current.result.browserCheckpoint;
    delete current.browserResumeClaim;
    if(valid){
     // A one-use continuation issued only by the login detector, not by the Runner.
     current.browserResumeClaim={scopeHash:current.environmentAccess.scopeHash,startedAt:current.environmentAccess.startedAt};
     current.status='queued';current.result=null;
    }
    else{const old=current.environmentAccess;const plan=planQuery(cfg,{environmentId:old.environmentId,queryId:old.queryId,parameters:old.parameters},current.projectId,{profile:current.originProfile,senderId:current.senderId});current.environmentAccess={...plan,approvalRequired:true,approvedBy:null,approvedAt:null};current.status='awaiting_environment_approval';current.result=null;}
    current.updatedAt=new Date().toISOString();current.events.push({type:'browser_login_resumed',at:current.updatedAt});
    const question=state.questions?.[current.questionId];if(question)question.generation++;
   });
  }catch{ /* Leave pending and retry after browser/network recovery, never discard original goal. */ }
 }
}
