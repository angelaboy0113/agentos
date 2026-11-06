import {readFile}from 'node:fs/promises';import path from 'node:path';import{catalog,compactCatalog,planQuery,verifyApprovedPlan}from './environment-access.js';import{sourceRuntimeTier}from './source-environments.js';
export async function loadIntegrationProjects(file){try{return JSON.parse(await readFile(path.resolve(file??process.env.AGENTOS_PROJECTS_FILE??'./config/projects.local.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return{projects:{}};throw e;}}
const denied=()=>Object.assign(Error('关联系统只读范围未授权或与本话题不匹配'),{queryDiagnostic:{code:'INTEGRATION_PEER_SCOPE',reason:'跨系统需要双向显式配置、同群绑定、只读分析与相同运行分级；不能借用其它项目权限或切换测试/生产。'}});
export function integrationPeerProjects(projects,job){
 if(job?.taskIntent!=='analysis'||job.originChatType!=='group'||!job.chatId||!job.originProfile)return[];
 const bindings=projects.chatProfileProjectMap?.[job.chatId]??{};if(bindings[job.originProfile]!==job.projectId)return[];
 const own=projects.projects?.[job.projectId],peers=own?.readOnlyIntegrationPeers;if(!Array.isArray(peers))return[];
 return [...new Set(peers)].filter(id=>typeof id==='string'&&id!==job.projectId&&Array.isArray(projects.projects?.[id]?.readOnlyIntegrationPeers)&&projects.projects[id].readOnlyIntegrationPeers.includes(job.projectId)&&Object.values(bindings).includes(id));
}
export function assertTaskReadScope(projects,job,cfg,planOrRequest){
 const e=cfg.environments[planOrRequest?.environmentId],q=e?.queries?.[planOrRequest?.queryId];
 if(!e||!q)throw denied();
 if(e.projectId===job.projectId)return e.projectId;
 const restricted=projects.projects?.[job.projectId]?.integrationPeerEnvironments?.[e.projectId];
 if(restricted!==undefined&&(!Array.isArray(restricted)||!restricted.includes(planOrRequest.environmentId)))throw denied();
 if(!integrationPeerProjects(projects,job).includes(e.projectId)||!['mysql','mongodb'].includes(e.kind)||q.mode!=='investigate'||sourceRuntimeTier(projects.projects[job.projectId],job.sourceEnvironment)!==e.tier)throw denied();
 return e.projectId;
}
export function planTaskRead(cfg,projects,job,request){const subject=assertTaskReadScope(projects,job,cfg,request),plan=planQuery(cfg,request,subject,{profile:job.originProfile??job.agentProfile,senderId:job.senderId});verifyApprovedPlan(cfg,plan);return plan;}
export function taskReadEnvironments(cfg,projects,job){const own=catalog(cfg,job.projectId),peers=integrationPeerProjects(projects,job).flatMap(id=>catalog(cfg,id).filter(e=>{try{return assertTaskReadScope(projects,job,cfg,{environmentId:e.environmentId,queryId:e.queries.find(q=>q.mode==='investigate')?.queryId})===id;}catch{return false;}}).map(e=>({...e,subjectProjectId:id,requestingProjectId:job.projectId,configuredDatabase:cfg.environments[e.environmentId]?.database,queries:e.queries.filter(q=>q.mode==='investigate')})));return [...own,...peers];}

export function integrationReadStatus(cfg,projects,job){
 if(job?.taskIntent!=='analysis'||job.originChatType!=='group'||projects.chatProfileProjectMap?.[job.chatId]?.[job.originProfile]!==job.projectId)return[];
 const own=projects.projects[job.projectId],bindings=projects.chatProfileProjectMap[job.chatId];let tier;try{tier=sourceRuntimeTier(own,job.sourceEnvironment);}catch{return[{requestingProjectId:job.projectId,status:'source_runtime_tier_unresolved',environmentCount:0}];}
 return [...new Set(Object.values(bindings))].filter(id=>id!==job.projectId).map(id=>{const configured=own?.readOnlyIntegrationPeers?.includes(id)===true,reciprocal=projects.projects[id]?.readOnlyIntegrationPeers?.includes(job.projectId)===true;const environments=Object.entries(cfg.environments).filter(([key,e])=>{try{return e.projectId===id&&e.tier===tier&&assertTaskReadScope(projects,job,cfg,{environmentId:key,queryId:Object.keys(e.queries).find(q=>e.queries[q].mode==='investigate')})===id;}catch{return false;}});return{subjectProjectId:id,requestingProjectId:job.projectId,tier,status:!configured?'relation_not_configured':!reciprocal?'reciprocal_relation_missing':!environments.length?'no_registered_read_scope':'available',environmentCount:environments.length};});
}
export function taskReadCatalog(cfg,projects,job){return {...compactCatalog(taskReadEnvironments(cfg,projects,job)),integrationReadStatus:integrationReadStatus(cfg,projects,job),integrationRule:'本系统取证路径受限不等于上游故障。先查本系统已有接收/落库及结果证据；确需协查时，仅用available目标独立签发只读票据。relation_not_configured需要维护者配置关联，不是账号密码失效；禁止改项目或冒用目标机器人绕过。'};}
