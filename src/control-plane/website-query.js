import {assertSourceRuntimeTier} from '../shared/source-environments.js';
import {stateView} from '../shared/state-view.js';
import { canonicalWebsite } from '../shared/website-aliases.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { environmentFile, loadEnvironments, planQuery, verifyApprovedPlan } from '../shared/environment-access.js';
import { websiteUrl, websiteKey } from '../shared/website-policy.js';
let updates=Promise.resolve();
const polling=new WeakMap();
export function prepareWebsiteQuery(context,job,request){
 const pending=updates.then(async()=>{
  if(!request||!['uat','prd'].includes(request.tier))throw Object.assign(new Error('网页排查运行分级无效'),{queryDiagnostic:{code:'WEBSITE_TIER_INVALID',reason:'网页排查未指定有效的测试/生产运行分级。',correction:'按协议使用 uat（测试）或 prd（生产），源码环境ID保持本项目配置。'}});
  const purpose=request.purpose;
  const issue=typeof purpose!=='string'?'type':!purpose.trim()?'empty':/[\u0000-\u001f\u007f]/.test(purpose)?'control_characters':purpose.length>200?'length':null;
  if(issue)throw Object.assign(new Error('Invalid website purpose'),{queryDiagnostic:{code:'TEXT_PARAMETER',index:0,reason:issue,length:typeof purpose==='string'?purpose.length:null,maxLength:200}});
  assertSourceRuntimeTier(context.projects.projects?.[job.projectId],job.sourceEnvironment,request.tier);
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
 const jobs=await stateView(context.store,s=>(s.jobs??[]).filter(j=>j.status==='awaiting_clarification'&&j.result?.browserLoginRequired===true&&j.environmentAccess?.kind==='website'));
 for(const job of jobs){
  try{
   const cfg=await loadEnvironments(),e=cfg.environments[job.environmentAccess.environmentId];if(!e)continue;
   await context.websiteCredentials?.autoLogin(job,e);
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
    else{const old=current.environmentAccess;const plan=planQuery(cfg,{environmentId:old.environmentId,queryId:old.queryId,parameters:old.parameters},current.projectId,{profile:current.originProfile,senderId:current.senderId});current.environmentAccess=plan;current.status=plan.approvalRequired?'awaiting_environment_approval':'queued';current.result=null;}
    current.updatedAt=new Date().toISOString();current.events.push({type:'browser_login_resumed',at:current.updatedAt});
    const question=state.questions?.[current.questionId];if(question)question.generation++;
   });
  }catch{ /* Leave pending and retry after browser/network recovery, never discard original goal. */ }
 }
}
