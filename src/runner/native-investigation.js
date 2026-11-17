import {readFile,open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {CodexAppServer} from '../shared/codex-app-server.js';
import {codexEnvironment,loadCodexRuntimeSettings,resolveCodexBinary,conversationServerArgs} from '../shared/codex-runtime.js';
import {artifactPermissionArgs,artifactPolicy} from '../shared/artifact-workspace.js';
import {failureDiagnostic} from '../shared/failure-diagnostic.js';
import {continuousReviewDecision} from '../shared/investigation-review.js';
import {ToolResultStore} from './tool-result-store.js';
import {InvestigationDirectTools,investigationDynamicTools} from './investigation-direct-tools.js';

import {nativeInvestigationEngine,useNativeInvestigation} from './investigation-entry.js';
export {nativeInvestigationEngine,useNativeInvestigation} from './investigation-entry.js';
// A reader page is already bounded by its trusted host reader. Do not page the
// JSON envelope again (Unicode and escaped JSON can exceed the byte display size).
export const presentNativeToolResult=(store,tool,result)=>store.present(tool,result,tool==='agentos_read_result'?Number.MAX_SAFE_INTEGER:24000,{persist:tool!=='agentos_read_result',reader:'agentos_read_result'});
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});

// A tool response is acknowledged only after it is durable. A crash between
// execution and receipt publication is uncertain, never permission to replay.
export class InvestigationCallJournal {
  constructor({directory,binding}) {this.directory=directory;this.binding=binding;this.pending=new Map();}
  async call(callId,input,run) {
    if(typeof callId!=='string'||!callId)throw failure('NATIVE_CALL_ID');
    const key=hash(JSON.stringify([this.binding,callId])),digest=hash(JSON.stringify(input));
    if(this.pending.has(key)){const prior=this.pending.get(key);if(prior.digest!==digest)throw failure('NATIVE_CALL_CONFLICT');return prior.promise;}
    const promise=this.perform(key,digest,run);this.pending.set(key,{digest,promise});
    try{return await promise;}catch(error){this.pending.delete(key);throw error;}
  }
  async perform(key,digest,run) {
    const file=path.join(this.directory,`.native-call-${key}.json`);
    try {
      const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||await realpath(file)!==file)throw failure('NATIVE_RECEIPT_BOUNDARY');
      const saved=JSON.parse(await readFile(file,'utf8'));
      if(saved.binding!==this.binding||saved.digest!==digest)throw failure('NATIVE_CALL_CONFLICT');
      if(saved.state!=='completed'||hash(JSON.stringify(saved.response))!==saved.sha256)throw failure('NATIVE_CALL_UNCERTAIN');
      return saved.response;
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    const handle=await open(file,'wx',0o600);
    try {
      await handle.writeFile(JSON.stringify({binding:this.binding,digest,state:'started'}));await handle.sync();
      const response=await run();
      const st=await lstat(file),owned=await handle.stat();
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.ino!==owned.ino||st.dev!==owned.dev||await realpath(file)!==file)throw failure('NATIVE_RECEIPT_BOUNDARY');
      const bytes=Buffer.from(JSON.stringify({binding:this.binding,digest,state:'completed',sha256:hash(JSON.stringify(response)),response}));
      await handle.write(bytes,0,bytes.length,0);await handle.truncate(bytes.length);await handle.sync();return response;
    } finally {await handle.close();}
  }
}

export async function runNativeInvestigation(options,adapters={}) {
  const {job,config,workspace,attachmentPaths=[],emit}=options;
  const runtime=await (adapters.runtime??loadCodexRuntimeSettings)();
  const direct=adapters.direct??new InvestigationDirectTools(options);
  const store=new ToolResultStore({readMaxCharacters:24000,directory:path.join(config.dataDir,'exports',job.id),scope:hash(JSON.stringify([job.id,job.questionId,job.originProfile??job.agentProfile,job.senderId]))});
  // Host receipts live outside the model-writable artifact working directory.
  const journalDirectory=await store.root();
  let journal,threadId,turnId,active=false,toolCalls=0,toolQueue=Promise.resolve(),progressTimer,modelTurns=0,hostContinuations=0;const began=Date.now();
  const onToolCall=async params=>{
    if(!active||params.threadId!==threadId||!turnId||params.turnId!==turnId||params.namespace!==null||!investigationDynamicTools.some(x=>x.name===params.tool)&&params.tool!=='agentos_read_result')throw failure('NATIVE_TOOL_SCOPE');
    const run=()=>journal.call(params.callId,{tool:params.tool,arguments:params.arguments},async()=>{
      if(!active)throw failure('NATIVE_TURN_ENDED');
      toolCalls++;
      try {
        const result=params.tool==='agentos_read_result'?(String(params.arguments.resultRef??'').startsWith('source-metadata/')?await direct.readSourceMetadata(params.arguments):await store.read(params.arguments)):await direct.call(params.tool,params.arguments);
        const presented=await presentNativeToolResult(store,params.tool,result);
        return {contentItems:[{type:'inputText',text:JSON.stringify(presented)}],success:true};
      } catch(error) {
        return {contentItems:[{type:'inputText',text:JSON.stringify({error:failureDiagnostic(error),executed:'unknown',guidance:'保留既有证据；根据具体原因修正参数或等待授权，不能假设失败工具已完成。'})}],success:false};
      }
    });
    const pending=toolQueue.then(run);toolQueue=pending.catch(()=>{});return pending;
  };
  const app=adapters.app??new CodexAppServer({cwd:workspace,codexBin:await resolveCodexBinary(config.codexBin),env:await codexEnvironment(),args:[...conversationServerArgs(),...artifactPermissionArgs(job.artifactWorkspace),'-c','features.shell_tool=true'],onToolCall});
  adapters.bindToolCall?.(onToolCall);
  const observe=({method,params})=>{if(active&&method==='turn/started'&&params.threadId===threadId)turnId=params.turn.id;};
  app.on('notification',observe);
  try {
    await app.start();const account=await app.readAccount({onRetry:({attempt})=>emit({type:'progress',phase:'model_login_retry',attempt})});
    if(account.account?.type!=='chatgpt')throw failure('CODEX_LOGIN_REQUIRED');
    const checkpoint=job.analysisContinuation;
    const resume=checkpoint?.executionEngine===nativeInvestigationEngine&&checkpoint.questionId===job.questionId&&checkpoint.workspace===workspace;
    const params={cwd:workspace,approvalPolicy:'never',permissions:job.artifactWorkspace.profile,...(runtime.model?{model:runtime.model}:{})};
    const thread=await app.request(resume?'thread/resume':'thread/start',resume?{...params,threadId:checkpoint.threadId,excludeTurns:true}:{...params,ephemeral:false,dynamicTools:[...investigationDynamicTools,{type:'function',name:'agentos_read_result',description:'分页读取本题已持久化的大工具结果或sourceHistory.artifact返回的source-metadata/证据路径；offset从0开始，limit最多24000字符，不重新查询。',inputSchema:{type:'object',additionalProperties:false,required:['resultRef','offset','limit'],properties:{resultRef:{type:'string'},offset:{type:'integer'},limit:{type:'integer',minimum:1,maximum:24000}}}}]});
    threadId=thread.thread.id;direct.threadId=threadId;
    journal=new InvestigationCallJournal({directory:journalDirectory,binding:hash(JSON.stringify([job.id,job.questionId,workspace,job.originProfile??job.agentProfile,job.senderId,threadId]))});
    await emit({type:'progress',phase:'native_investigation_started',sourceContinuation:{questionId:job.questionId,workspace,threadId,artifactPolicy,executionEngine:nativeInvestigationEngine},message:'同一调查会话已接通授权工具，直接取证并继续分析'});
    active=true;
    progressTimer=setInterval(()=>emit({type:'progress',phase:'codex_working',elapsedSeconds:Math.round((Date.now()-began)/1000),executionEngine:nativeInvestigationEngine}).catch(()=>{}),10000);progressTimer.unref();
    const initial=await direct.openInitial?.();
    const initialInput=initial?'\n接单时已批准的首个只读来源已在同一会话内打开。先使用此目录继续取证，勿重复打开或重复查询；结束来源后再核对完整原问题：\n'+JSON.stringify(await presentNativeToolResult(store,'initial_environment',initial)):'';
    let result;let input;
    for(;;){
    modelTurns++;const answer=await app.turn({threadId,approvalPolicy:'never',effort:runtime.reasoningEffort??'low',input:input??[{type:'text',text:options.prompt+initialInput+'\n执行方式：优先直接使用agentos_*工具，保持当前会话。environment_open只申请既有范围，返回目录后用environment_tool直接执行；close保存每个来源的核验收据，再按需打开另一来源。来源结束不等于原问题完成。按用户要求的粒度交付：完整列齐对象不等于穷尽每个对象的所有内部实现、历史和副作用；未被要求且不影响结论的深挖不能升级为交付前置条件。已取得足够证据后集中核验交付，不逐个子步骤回报partial。用户基于给定前提要求方案或重做文件时，不得擅自将重查全部前提作为交付条件；未独立重查的前提如实说明，用户另行要求的代码变化/金额核验仍须取证。单个来源鉴权、范围或查询失败只约束该来源，不得重复失败操作或扩大权限；关闭并保存其缺口后，继续可独立完成的源码核对、其它已授权来源、文件制作与核验。用户要求文件时，可交付明确标注已核实范围与缺项的有用部分文件，不能因部署核验缺口而连源码接口清单都不整理；不得把源码接口冒称为线上已部署接口，亦不得将部分交付说成全部成功。无需输出中间environmentQuery/sourceHistoryQuery结束本轮；最终仍按原schema和真实证据交付。源码通过现有只读shell；业务数据库/网页/日志/历史补取必须使用受控工具。缺登录或权限保留等待；禁止自行连接数据库或绕过受控网页。'},...attachmentPaths.filter(x=>x.type==='image').map(x=>({type:'localImage',path:x.path}))],outputSchema:JSON.parse(await readFile(new URL('../../config/task-result.schema.json',import.meta.url),'utf8'))},{onEvent:method=>{if(method==='item/started')emit({type:'progress',phase:'codex_working'}).catch(()=>{});}});
    active=false;
    result=JSON.parse(answer.text);
    if(!['ready','partial','needs_clarification','blocked'].includes(result.outcome)||!result.finalMessage?.trim())throw failure('CODEX_RESULT_INVALID');
    // Consume legacy-shaped read continuations inside this same thread. Older
    // prompt/schema habits must not silently re-enter the nested model pipeline.
    const continuation=result.environmentQuery?{name:'agentos_environment_open',args:{request:JSON.stringify(result.environmentQuery),website:false}}:result.websiteQuery?{name:'agentos_environment_open',args:{request:JSON.stringify(result.websiteQuery),website:true}}:result.sourceHistoryQuery?{name:'agentos_source_history',args:{query:JSON.stringify(result.sourceHistoryQuery)}}:null;
    if(direct.waiting||result.sourceEnvironmentQuery)break;
    let observation;
    if(direct.channel)observation=await journal.call('host-close-'+turnId,{complete:false},()=>direct.call('agentos_environment_close',{summary:'保存本来源既有证据；继续同一调查会话核验下一来源。',complete:false}));
    if(direct.waiting)break;
    // A premature finish is corrective feedback, not a closed channel. Return
    // that observation to the same model instead of opening a second source or
    // waiting indefinitely during teardown.
    if(!direct.channel){
      if(continuation)observation=await journal.call('host-continuation-'+turnId,continuation,()=>direct.call(continuation.name,continuation.args));
      else if(!result.documentRequests?.length&&continuousReviewDecision(direct.job,result).continue){
        // A normal work-in-progress result belongs to this live thread. Sending
        // it back through the runner reopens the app and reloads source/skills.
        // Persist the intermediate evidence, but never publish it as delivery.
        observation={state:'analysis_continuing',result};
        await emit({type:'progress',phase:'native_analysis_continuing',message:'继续同一调查会话处理尚未完成的原需求，已有来源和成果保持'});
      }else break;
    }
    hostContinuations++;
    if(observation.state==='source_transition_required'){result={...result,environmentQuery:null,websiteQuery:null,sourceEnvironmentQuery:observation.sourceEnvironmentQuery};break;}
    if(direct.waiting)break;
    const presented=await store.present('host_continuation',observation,24000,{persist:true,reader:'agentos_read_result'});
    input=[{type:'text',text:(observation.state==='analysis_continuing'?'原需求仍有可执行工作；保持用户实际要求的粒度，不把未要求的逐对象深层规则穷尽当作完成前置条件。中间证据已持久化，继续在当前会话直接完成取证、制作和核验，不必交回OS重新准备源码或技能。保留原身份、固定源码和工具范围，不重复已经完成的查询；真实外部缺口则准确记录，不虚报成功。':'你输出了旧式接续申请；宿主已按原身份与范围在本会话执行，结果如下。')+'继续使用agentos_*工具完成同一原问题，不需要结束本轮交回OS或再写environmentQuery/websiteQuery/sourceHistoryQuery。只有真实等待、最终交付或独立源码环境交接才结束。关闭当前来源后可直接打开下一已授权来源。最终结果把已经执行的旧式申请字段设为null。\n'+JSON.stringify(presented)}];
    active=true;
    }
    if(direct.channel){await direct.call('agentos_environment_close',{summary:'外层结束前保存已有证据；本来源尚未声明完成。',complete:false});result={...result,outcome:'partial',summary:'已有取证已保存，仍需完成原问题核验'};}
    if(direct.waiting)result={...result,...direct.waiting};
    return {...result,threadId,executionEngine:nativeInvestigationEngine,model:runtime.model,reasoningEffort:runtime.reasoningEffort,artifactPolicy,hostCurrentJob:direct.job,sourceHistory:direct.lastSourceHistory??null,sourceEvidenceReceipts:direct.sourceReceipts,nativeTiming:{totalMs:Date.now()-began,toolCalls,modelSessions:1,modelTurns,hostContinuations,environmentModelSessions:0}};
  } catch(error) {if(threadId)error.threadId=threadId;throw error;}
  finally {active=false;clearInterval(progressTimer);app.off('notification',observe);try{await direct.close();}finally{await app.close();}}
}
