import {mkdir,readFile,writeFile,rename,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {runLarkCli} from './lark-cli.js';
import {inputFileMetadata,inputFileName} from '../shared/input-files.js';
import {sanitizeSegment} from '../shared/protocol.js';
import {hashFile} from '../shared/file-digest.js';
const portableName=value=>{let name=inputFileName(value).replace(/[<>:"|?*]/g,'_').replace(/[. ]+$/g,'');if(!name||name==='.'||name==='..')name='file';if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;return name;};
const formats={docx:'markdown',doc:'docx',sheet:'xlsx',slides:'pptx'};
const extension={markdown:'md'};
const fail=(code,message,fields={})=>Object.assign(new Error(message),{code,...fields});
function classify(error,url){
 const e=error.cliError??{},kind=e.subtype??e.type??'',code=e.code??error.code;
 const scopes=Array.isArray(e.missing_scopes)?e.missing_scopes.filter(x=>typeof x==='string'):[];
 if(kind==='missing_scope'||scopes.length||code===99991679){const preferred=scopes.includes('drive:file:download')?'drive:file:download':scopes.find(s=>/:readonly|:read$/.test(s))??scopes[0];return {code:'CLOUD_APP_SCOPE_MISSING',url,missingScopes:scopes,...(preferred?{suggestedScope:preferred}:{}),message:'当前机器人应用尚未开通此云文件读取接口的权限'+(preferred?'，建议管理员开通 '+preferred:'')+'。接口列出的候选权限满足其中一项即可，不需要全部申请。批准并发布后，回复原话题“已授权，请重试”；尚未读取文件内容。'};}
 if(/permission|forbidden|access_denied/i.test(kind)||/permission denied|forbidden|无权限|没有权限|无权/i.test(e.message??'')||[403,1061004,1061005,99991672].includes(code))return {code:'CLOUD_FILE_ACCESS_DENIED',url,message:'当前机器人尚无此文件的阅读/下载权限。请在文件分享中授予当前机器人所需权限后，回复原话题“已共享，请重试”；不需要向全公司或互联网公开。'};
 const known=['CLOUD_FOLDER_SELECTION','CLOUD_RESOURCE_TYPE','CLOUD_EXPORT_FAILED','CLOUD_EXPORT_STATE','CLOUD_INPUT_MISSING','CLOUD_INPUT_PATH','CLOUD_BOT_PROFILE_MISSING'];
 return {code:known.includes(error.code)?error.code:'CLOUD_DOWNLOAD_FAILED',url,message:known.includes(error.code)?error.message:'云文件本次未能读取，尚未取得有效附件。请核对链接、文件是否仍存在及机器人可读范围；这不代表文件内容为空，也不是业务根因。'};
}
export class CloudFiles {
 constructor(context,adapters={}){this.context=context;this.run=adapters.run??runLarkCli;this.wait=adapters.wait??((ms,signal)=>wait(ms,undefined,{signal}));}
 async command(args,turn,cwd,signal){
  signal?.throwIfAborted();
  if(!turn.profile)throw fail('CLOUD_BOT_PROFILE_MISSING','当前机器人尚未配置对应的云文件读取身份，请维护者补齐该机器人的CLI profile；不会改用个人账号或其他机器人。');
  return this.run(['drive',...args,'--as','bot','--json'],{cwd,profile:turn.profile,cliEntry:this.context.config.feishu?.cliEntry,timeoutMs:false,signal});
 }
 async prepare(turn,{signal,onProgress=async()=>{}}={}){
  const attachments=[],issues=[],links=turn.cloudFileLinks??[];
  for(const [i,link]of links.entries()){
   signal?.throwIfAborted();
   const progress=async(phase,name)=>onProgress({phase,current:i+1,completed:i,total:links.length,...(name?{name}:{}),updatedAt:new Date().toISOString()});
   try{attachments.push(await this.download(turn,link,{signal,progress}));}
   catch(error){if(signal?.aborted||error.name==='AbortError')throw error;issues.push(classify(error,link.url));}
  }
  await onProgress({phase:issues.length?'partial':'ready',completed:attachments.length,total:links.length,failed:issues.length,updatedAt:new Date().toISOString()});
  return {attachments,issues};
 }
 async download(turn,link,{signal,progress}){
  const key=createHash('sha256').update(link.url).digest('hex');
  const root=path.join(this.context.config.dataDir,'lark-cli-events',sanitizeSegment(turn.profile??'default'),'messages',sanitizeSegment(turn.messageId),'cloud-files',key.slice(0,24));await mkdir(root,{recursive:true,mode:0o700});
  const receipt=path.join(root,'receipt.json');
  try{const r=JSON.parse(await readFile(receipt,'utf8'));const cached=await realpath(r.attachment.path??'');const realRoot=await realpath(root);const rel=path.relative(realRoot,cached);if(r.requestId===turn.id&&r.profile===turn.profile&&r.chatId===turn.chatId&&r.senderId===turn.senderId&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&(await hashFile(r.attachment.path))===r.attachment.sha256)return r.attachment;}catch{}
  await progress('identify');
  const inspected=await this.command(['+inspect','--url',link.url],turn,root,signal);const meta=inspected.data??inspected;
  const type=meta.type==='sheets'?'sheet':meta.type,token=meta.token;
  if(type==='folder')throw fail('CLOUD_FOLDER_SELECTION','这是文件夹链接，请提供要分析的具体文件链接，或明确需要处理哪些文件。');
  if(!/^[A-Za-z0-9_-]+$/.test(token??'')||(!formats[type]&&type!=='file'))throw fail('CLOUD_RESOURCE_TYPE','尚未取得可下载的文件或可导出的文档类型，请核对原文件链接。');
  const checkpoint=path.join(root,'pending-export.json');let saved;
  try{const c=JSON.parse(await readFile(checkpoint,'utf8'));const local=await realpath(c.attempt),base=await realpath(root),rel=path.relative(base,local);if(c.requestId===turn.id&&c.profile===turn.profile&&c.chatId===turn.chatId&&c.senderId===turn.senderId&&c.token===token&&c.type===type&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&path.basename(c.name)===c.name)saved=c;}catch{}
  const attempt=saved?.attempt??path.join(root,randomUUID());if(!saved)await mkdir(attempt,{mode:0o700});
  let originalName=saved?.originalName??(inputFileName(meta.title)||token),name=saved?.name??portableName(originalName),result;
  if(type==='file'){
   await progress('download',name);
   result=await this.command(['+download','--file-token',token,'--output',name],turn,attempt,signal);
  }else{
   const format=formats[type],ext=extension[format]??format;if(!saved){name=path.basename(name,path.extname(name))+'.'+ext;originalName=path.basename(originalName,path.extname(originalName))+'.'+ext;}
   await progress(saved?'waiting_export':'export',name);
   let data=saved?.data;
   if(!saved){result=await this.command(['+export','--token',token,'--doc-type',type,'--file-extension',format,'--file-name',name,'--output-dir','.'],turn,attempt,signal);data=result.data??result;}
   const ticket=saved?.ticket??data.ticket;
   const remember=async()=>{const temp=checkpoint+'.'+randomUUID()+'.tmp';const state={requestId:turn.id,profile:turn.profile,chatId:turn.chatId,senderId:turn.senderId,token,type,attempt,name,originalName,ticket,data:{ready:data.ready,failed:data.failed,timed_out:data.timed_out,file_token:data.file_token}};await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,checkpoint);};
   if(ticket||data.file_token)await remember();
   // Keep the same durable export ticket across CLI polling windows and local restarts.
   while(data.ready===false||data.timed_out===true){
    if(data.failed)throw fail('CLOUD_EXPORT_FAILED','飞书云文档导出失败，未取得可分析文件。');
    if(!ticket)throw fail('CLOUD_EXPORT_STATE','导出尚未完成，但服务端未提供可接续任务编号。');
    await progress('waiting_export',name);await this.wait(3000,signal);
    result=await this.command(['+task_result','--scenario','export','--ticket',ticket,'--file-token',token],turn,attempt,signal);data=result.data??result;await remember();
   }
   if(data.failed)throw fail('CLOUD_EXPORT_FAILED','飞书云文档导出失败，未取得可分析文件。');
   const out=path.join(attempt,name);
   if(!(await stat(out).catch(()=>null))?.isFile()){
    if(!data.file_token)throw fail('CLOUD_INPUT_MISSING','导出返回后未找到完整文件或可接续的导出产物。');
    await progress('download',name);
    await this.command(['+export-download','--file-token',data.file_token,'--file-name',name,'--output-dir','.'],turn,attempt,signal);
   }
  }
  signal?.throwIfAborted();
  const file=await realpath(path.join(attempt,name)).catch(()=>null);const real=await realpath(attempt);const rel=file&&path.relative(real,file);
  if(!file||rel.startsWith('..')||path.isAbsolute(rel))throw fail('CLOUD_INPUT_PATH','下载文件未通过本消息目录归属核对，未交给模型读取。');
  const attachment={...await inputFileMetadata(file,{id:`CLOUD-${key.slice(0,24)}`,name:originalName,sourceMessageId:turn.messageId}),sourceUrl:link.url,cloudResourceTitle:meta.title??originalName,cloudResourceType:type,readAt:new Date().toISOString(),...(type!=='file'?{exported:true}:{})};
  const temp=receipt+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify({requestId:turn.id,profile:turn.profile,chatId:turn.chatId,senderId:turn.senderId,attachment}),{mode:0o600});await rename(temp,receipt);
  return attachment;
 }
}
