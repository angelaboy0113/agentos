import {InvestigationToolChannel} from './investigation-tool-channel.js';
import {executeEnvironmentJob} from './environment-job.js';
import {controlPost} from './control-client.js';
import {runWithSourceHistory} from './source-history-runner.js';
import {loadEnvironments} from '../shared/environment-access.js';
import {currentUserQuestion} from '../shared/user-request-scope.js';
import {requestedSourceEnvironments} from '../shared/source-comparison.js';
import {sourceRuntimeTier,assertSourceRuntimeTier} from '../shared/source-environments.js';
import {environmentPlannerInstructions} from './environment-planner-instructions.js';
import {sourceCommitMetadataArtifact} from './source-commit-metadata.js';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const objectSchema=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const str={type:'string'};
export const investigationDynamicTools=[
  {type:'function',name:'agentos_source_history',description:'读取本题固定仓库的历史、提交或独立分支。query为原sourceHistoryQuery JSON；沿用固定SHA和范围核验，不结束调查。',inputSchema:objectSchema({query:str})},
  {type:'function',name:'agentos_environment_open',description:'申请本题已授权的数据库/网页/日志/平台只读工具。request为environmentQuery或websiteQuery的JSON；website标明网页申请。只创建工具执行器，不创建另一个模型。先结束当前环境，再打开另一来源。',inputSchema:objectSchema({request:str,website:{type:'boolean'}})},
  {type:'function',name:'agentos_environment_tool',description:'在当前环境直接调用返回目录中的一个工具。arguments为JSON对象字符串，summary是工具目的。现有批量工具可减少往返；结果直接返回当前调查会话。',inputSchema:objectSchema({tool:str,arguments:str,summary:str})},
  {type:'function',name:'agentos_environment_close',description:'保存当前来源的证据、独立核验和文件收据。complete只表示本来源步骤完成，不表示整个用户问题完成。缺扫码/审批时保存等待状态。',inputSchema:objectSchema({summary:str,complete:{type:'boolean'}})},
];

const parse=text=>{const v=JSON.parse(text);if(!v||Array.isArray(v)||typeof v!=='object')throw new Error('Expected JSON object');return v;};
export class InvestigationDirectTools {
  constructor(options,adapters={}) {
    this.options=options;this.job=options.job;this.post=adapters.post??((route,body)=>controlPost(options.config,route,body));
    this.execute=adapters.execute??executeEnvironmentJob;this.history=adapters.history??runWithSourceHistory;
    this.loadEnvironments=adapters.loadEnvironments??loadEnvironments;
    this.sourceReceipts=[];this.sourceResults=new Map();this.instructionKinds=new Set();this.closed=false;
  }
  identity() {return {runnerId:this.job.lease.runnerId,leaseId:this.job.lease.id};}
  route(suffix) {return `/api/v1/jobs/${encodeURIComponent(this.job.id)}/${suffix}`;}
  async untriedLogSources(result) {
    const blocker=result.investigation?.blocker;
    if(this.job.taskIntent!=='analysis'||result.investigation?.status!=='wait'||blocker?.kind!=='unavailable'
      ||!/(日志|异常栈|\b(?:logs?|stack trace)\b)/i.test(blocker.needed??'')
      ||/(?:无需|不要|不用|不需要).{0,8}(?:查|读|看)?日志|\b(?:do not|don.t)\s+(?:read|check|query)\s+(?:the\s+)?logs?/i.test(currentUserQuestion(this.job)))return [];
    let tier;
    try{tier=sourceRuntimeTier(this.options.project,this.job.sourceEnvironment);}catch{return [];}
    const config=await this.loadEnvironments().catch(()=>null);
    if(!config)return [];
    const attempts=(this.job.context??[]).filter(c=>c.kind==='environment_result').flatMap(c=>
      (c.result?.toolResultCatalog??[]).filter(item=>item.tool==='search_logs')
        .map(item=>({environmentId:c.result.environmentEvidence?.environmentId,applicationId:item.applicationId})));
    const candidates=Object.entries(config.environments)
      .filter(([,e])=>e.kind==='tsf'&&e.projectId===this.job.projectId&&e.tier===tier)
      .flatMap(([environmentId,e])=>Object.entries(e.queries??{}).filter(([,q])=>q.logApplications?.length&&!q.logReadWindow)
        .map(([queryId,q])=>({environmentId,queryId,applications:q.applications.filter(app=>q.logApplications.includes(app.applicationId))})));
    const clue=[currentUserQuestion(this.job),blocker.needed,blocker.evidence].join(' ').toLowerCase();
    const named=candidates.map(source=>({...source,applications:source.applications.filter(app=>
      [app.applicationId,app.applicationName].some(name=>name&&clue.includes(name.toLowerCase())))}))
      .filter(source=>source.applications.length);
    if(named.length)return named.map(source=>({...source,applications:source.applications.filter(app=>
      !attempts.some(a=>a.environmentId===source.environmentId&&(!a.applicationId||a.applicationId===app.applicationId)))}))
      .filter(source=>source.applications.length);
    // Without a specific second service, one completed search is enough reason
    // to avoid guessing and scanning the rest of the deployment catalog.
    return candidates.some(source=>attempts.some(a=>a.environmentId===source.environmentId))?[]:candidates;
  }
  async openInitial() {
    if(!this.job.environmentAccess||this.initialOpened)return null;
    assertSourceRuntimeTier(this.options.project,this.job.sourceEnvironment,this.job.environmentAccess.tier);
    this.initialOpened=true;
    return this.beginEnvironment();
  }
  async beginEnvironment() {
    if(this.closed||this.channel)throw new Error('Close the current environment before opening another');
    this.channel=new InvestigationToolChannel();
    const channel=this.channel;
    this.running=this.execute(this.job,this.options.config,this.options.emit,{planner:async({kind}={})=>{if(!this.instructionKinds.has(kind)){channel.instructions=environmentPlannerInstructions(kind);this.instructionKinds.add(kind);}return channel.planner();}}).then(result=>channel.settle(result),error=>channel.fail(error));
    return this.observe(await channel.observe());
  }
  async readSourceMetadata({resultRef,offset=0,limit=24000}) {
    if(this.closed)throw new Error('Investigation tools closed');
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>24000)throw Object.assign(new Error('源码证据分页参数无效；offset非负，limit为1至24000字符'),{code:'REPORT_INPUT'});
    const job={...this.job,sourceReferenceScope:this.options.sourceSync,sourceEvidenceReceipts:[...(this.job.sourceEvidenceReceipts??[]),...this.sourceReceipts]};
    const proof=await sourceCommitMetadataArtifact(this.options.config.dataDir,job,resultRef),bytes=await readFile(proof.file);
    if(createHash('sha256').update(bytes).digest('hex')!==proof.sha256)throw Object.assign(new Error('SOURCE_METADATA_ARTIFACT_CHANGED'),{code:'SOURCE_METADATA_ARTIFACT_CHANGED'});
    const text=bytes.toString('utf8'),end=Math.min(text.length,offset+limit);
    return {resultRef,offset,text:text.slice(offset,end),nextOffset:end<text.length?end:null,totalCharacters:text.length,sha256:proof.sha256,binding:proof.binding,deploymentVerified:false,note:'仅分页读取本题已核验源码元数据，不重新取数；Git身份与时间不等于平台合并或部署证据。'};
  }
  async call(name,args) {
    if(this.closed)throw new Error('Investigation tools closed');
    if(name==='agentos_source_history') {
      const query=parse(args.query),key=JSON.stringify(query);
      if(this.sourceResults.has(key))return {...this.sourceResults.get(key),reused:true};
      let first=true;
      const result=await this.history({...this.options,job:this.job,emit:async event=>this.options.emit({...event,...(event.sourceContinuation?{sourceContinuation:{...event.sourceContinuation,artifactPolicy:this.job.artifactWorkspace?.policy,executionEngine:'native-tools-v1'}}:{})})},{run:async()=>first?(first=false,{outcome:'partial',finalMessage:'直接读取源码证据',sourceHistoryQuery:query,threadId:this.threadId}):{outcome:'partial',finalMessage:'源码证据已返回当前会话',sourceHistoryQuery:null,threadId:this.threadId}});
      this.sourceReceipts.push(...result.sourceEvidenceReceipts);
      this.lastSourceHistory=result.sourceHistory;
      const out={sourceHistory:result.sourceHistory,sourceEvidenceReceipts:result.sourceEvidenceReceipts};this.sourceResults.set(key,out);return out;
    }
    if(name==='agentos_environment_open') {
      if(this.channel)throw new Error('Close the current environment before opening another');
      if(typeof args.website!=='boolean')throw new Error('Invalid environment request');
      const query=parse(args.request);
      if(this.options.project){
        const tier=args.website?query.tier:(await this.loadEnvironments()).environments[query.environmentId]?.tier;
        const other=requestedSourceEnvironments(this.job,this.options.project).find(env=>env!==this.job.sourceEnvironment&&sourceRuntimeTier(this.options.project,env)===tier);
        if(other)return {state:'source_transition_required',sourceEnvironmentQuery:{environmentId:other,reason:'先核对目标环境独立固定源码，再读取对应环境'},instruction:'先按原schema提交已核验源码交接及此sourceEnvironmentQuery。不能用当前环境源码替代另一环境；不在工具内静默切换。'};
      }
      // Native tools do not submit an intermediate model result. Retain a host-owned
      // open original goal so explicit goalIds can pass the same continuation
      // validation as legacy results. Do not invent arbitrary goal IDs supplied by
      // a caller or mark a goal verified merely because a source was opened.
      const investigation={status:'continue',goals:[{id:'original-question',required:true,status:'open',evidence:String(this.job.originalQuestion??this.job.instruction??'当前原问题仍在取证')} ]};
      const sourceResult={outcome:'needs_clarification',investigation,summary:'同一会话申请已授权只读取证',finalMessage:'调查仍在进行；下一步目的：'+String(query.reason??query.purpose??query.parameters?.[0]??''),sourceSync:this.options.sourceSync,workspace:this.options.workspace,threadId:this.threadId,sourceQuestionId:this.job.questionId,[args.website?'websiteQuery':'environmentQuery']:query};
      const prepared=await this.post(this.route('continuous-environment'),{...this.identity(),result:sourceResult});
      if(prepared.job)this.job=prepared.job;
      if(!prepared.planned)return {state:'not_opened',diagnostic:prepared.diagnostic,sourcePreparedNext:prepared.sourcePreparedNext===true,terminalResult:prepared.terminalResult};
      return this.beginEnvironment();
    }
    if(!this.channel)throw new Error('No authorized environment is open');
    if(name==='agentos_environment_tool') {
      const parameters=parse(args.arguments);
      if(args.tool==='finish')return this.call('agentos_environment_close',{summary:args.summary,complete:args.complete===true});
      if(args.tool==='continue_environment'){
        if(typeof parameters.environmentId!=='string'||typeof parameters.queryId!=='string'||!Array.isArray(parameters.parameters)||!parameters.parameters.length||parameters.parameters.some(x=>typeof x!=='string'))throw new Error('Use an explicitly selected authorized environmentId, queryId and parameters');
        // The published inner catalog offers this alias. Let its existing validator
        // save current evidence, then issue the next normal host-approved grant.
        const saved=await this.observe(await this.channel.choose({...args,complete:false}));
        if(saved.state!=='saved'||!saved.result?.nextEnvironmentQuery)return saved;
        const next=await this.call('agentos_environment_open',{request:JSON.stringify(saved.result.nextEnvironmentQuery),website:false});
        return {...next,previousSource:saved};
      }
      return this.observe(await this.channel.choose({...args,complete:false}));
    }
    if(name==='agentos_environment_close')return this.observe(await this.channel.choose({tool:'finish',arguments:'{}',summary:args.summary,complete:args.complete===true}));
    throw new Error('Unknown investigation tool');
  }
  async observe(value) {
    if(value.state!=='finished')return value;
    const result=value.result;
    if(result.browserLoginRequired||!['ready','partial'].includes(result.outcome)) {
      this.waiting=result; // Preserve the formal waiting grant, never call a failed read successful.
    } else {
      const saved=await this.post(this.route('continuous-environment-result'),{...this.identity(),result});this.job=saved.job;
    }
    this.channel=null;await this.running;this.running=null;
    return {state:this.waiting?'waiting':'saved',result};
  }
  async close() {
    this.closed=true;
    if(this.channel){await this.channel.stop();await this.running;this.channel=null;}
  }
}
