import {collectCloudSheetPage,assertCloudSheetPageSet,assembleCloudSheetPages} from './cloud-sheet-pages.js';
import {exactText} from './dataset-transform.js';
import {createHash} from 'node:crypto';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
// Platform adapter: explicit task document only, GET-only, originating bot identity.
export function cloudSheetTarget(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(u.hostname))return null;
 const m=/^\/(wiki|sheets|docx)\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);return m?{kind:m[1],token:m[2]}:null;}catch{return null;}
}
export function cloudReadRoute(route){return route==='/open-apis/wiki/v2/spaces/get_node'||/^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9]+\/blocks$/.test(route)||/^\/open-apis\/sheets\/v3\/spreadsheets\/[A-Za-z0-9]+\/sheets\/query$/.test(route)||/^\/open-apis\/sheets\/v2\/spreadsheets\/[A-Za-z0-9]+\/values\/[A-Za-z0-9]+(?:!|%21)[A-Z]+[0-9]+%3A[A-Z]+[0-9]+$/i.test(route);}
export class CloudSheetError extends Error{constructor(code,message){super(message);this.code=code;this.statusCode=400;}}
const invalid=()=>new CloudSheetError('CLOUD_DOCUMENT_INPUT','使用当前文档元数据返回的sheetId和有效行列范围；此工具只读取本任务已批准的表格，不接受其他URL。');
const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const extensionOf=title=>{const match=/\.([A-Za-z0-9]{1,10})$/.exec(String(title??''));return match?match[1].toLowerCase():'';};
const textDecoder=new TextDecoder('utf-8',{fatal:true});
function documentBlocksText(blocks){
 const lines=[];const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(['block_id','parent_id','children','block_type'].includes(key))continue;if(key==='content'&&typeof child==='string')lines.push(child);else if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);}};
 for(const block of blocks){const before=lines.length;visit(block);if(lines.length>before)lines.push('\n');}
 return lines.join('').replace(/\n{3,}/g,'\n\n').trim();
}
async function parseUploadedCloudFile(title,bytes){
 const extension=extensionOf(title),plain={txt:'text/plain',md:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',json:'application/json',xml:'application/xml',yaml:'application/yaml',yml:'application/yaml'};
 if(extension==='docx'){
  let result;try{result=await mammoth.extractRawText({buffer:bytes});}catch{throw new CloudSheetError('CLOUD_DOCUMENT_FORMAT','Word 文件无法按 DOCX 结构读取；已保留真实格式错误，未当作空文档或网页登录失败。');}
  return {extension,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',content:result.value,structure:{warnings:result.messages.map(x=>String(x.message??x)).slice(0,50)}};
 }
 if(extension==='xlsx'){
  const workbook=new ExcelJS.Workbook();try{await workbook.xlsx.load(bytes);}catch{throw new CloudSheetError('CLOUD_DOCUMENT_FORMAT','Excel 文件无法按 XLSX 结构读取；未当作空表。');}
  const sheets=workbook.worksheets.map(sheet=>({title:sheet.name,rowCount:sheet.rowCount,columnCount:sheet.columnCount,values:Array.from({length:sheet.rowCount},(_,index)=>{const row=sheet.getRow(index+1);return Array.from({length:sheet.columnCount},(_,column)=>{const cell=row.getCell(column+1);return cell.text??'';});})}));
  return {extension,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',content:sheets.map(sheet=>`# ${sheet.title}\n`+sheet.values.map(row=>row.join('\t')).join('\n')).join('\n\n'),structure:{sheets:sheets.map(({title,rowCount,columnCount})=>({title,rowCount,columnCount})),values:sheets}};
 }
 if(plain[extension]){let content;try{content=textDecoder.decode(bytes);}catch{throw new CloudSheetError('CLOUD_DOCUMENT_FORMAT','文本文件不是有效 UTF-8；未替换损坏字符或当作空文件。');}return {extension,contentType:plain[extension],content,structure:null};}
 throw new CloudSheetError('CLOUD_DOCUMENT_FORMAT',`当前文件格式${extension?` .${extension}`:'（无扩展名）'}尚未接入结构化读取；已识别为飞书上传文件，不会错误转入个人网页会话。请维护者补充该格式解析器。`);
}
export async function readCloudSheet(client,job,environment,tool,args={}){
 const url=job.environmentAccess?.websiteTarget??environment.baseUrl,target=cloudSheetTarget(url);
 if(!target||environment.kind!=='website'||environment.projectId!==job.projectId||!job.originProfile)throw invalid();
 if(!['connection','read_cloud_sheet','read_cloud_document'].includes(tool)||!args||Array.isArray(args)||typeof args!=='object')throw invalid();
 const request=async(route,params={})=>{if(!cloudReadRoute(route))throw invalid();try{return await client.cloudRequest(route,params,{profile:job.originProfile});}catch(error){if(error instanceof CloudSheetError)throw error;const message=String(error.message??'');const scope=/app_scope_not_applied|99991672|99991679/i.test(message);throw new CloudSheetError(scope?'CLOUD_DOCUMENT_SCOPE':'CLOUD_DOCUMENT_ACCESS',scope?'机器人应用缺少当前节点所需的知识库、电子表格或在线文档只读权限；请维护者核对应用权限。不是个人会话问题。':'机器人未能读取该文档；请核对文档是否对当前机器人开放、应用权限和平台网络。不需要在群里发送个人账号密码。');}};
 let token=target.token,title=null,documentType=target.kind==='docx'?'docx':'sheet';
 if(target.kind==='wiki'){
  const node=(await request('/open-apis/wiki/v2/spaces/get_node',{token})).node;
  if(!['sheet','file','docx'].includes(node?.obj_type)||!/^[A-Za-z0-9]+$/.test(node.obj_token??''))throw new CloudSheetError('CLOUD_DOCUMENT_TYPE','此知识库节点不是当前支持的在线表格、在线文档或上传文件；没有降级为个人网页会话。');
  token=node.obj_token;title=node.title;documentType=node.obj_type;
 }
 if(documentType!=='sheet'){
  if(tool==='connection'){
   if(Object.keys(args).length)throw invalid();
   return {nativeDocument:true,documentType,title,readAt:new Date().toISOString(),identity:'originating_bot',note:documentType==='file'?'这是知识库中的上传文件；用 read_cloud_document 以原机器人身份下载并读取。':'这是飞书在线文档；用 read_cloud_document 以原机器人身份读取正文。'};
  }
  if(tool!=='read_cloud_document'||Object.keys(args).length)throw new CloudSheetError('CLOUD_DOCUMENT_INPUT','当前节点不是电子表格；请使用 read_cloud_document，不要尝试网页登录或表格接口。');
  if(documentType==='file'){
   let bytes;try{bytes=await client.cloudDownload(token,{profile:job.originProfile});}catch(error){const message=String(error.message??'');const scope=/app_scope_not_applied|99991672|99991679/i.test(message);throw new CloudSheetError(scope?'CLOUD_DOCUMENT_SCOPE':'CLOUD_DOCUMENT_ACCESS',scope?'机器人应用缺少云空间文件只读/下载权限；请维护者为当前机器人申请 drive:drive:readonly。不是个人会话问题。':'当前机器人无法读取该文件；请确认文件已共享给对应机器人，且文件没有被删除或同时限制下载与预览。');}
   const parsed=await parseUploadedCloudFile(title,bytes);
   return {nativeDocument:true,documentType,title,readAt:new Date().toISOString(),identity:'originating_bot',fileToken:token,fileBytes:bytes,contentType:parsed.contentType,extension:parsed.extension,content:parsed.content,structure:parsed.structure,note:'内容来自原机器人通过飞书原生文件接口下载的同一文件；原始字节将按当前任务、系统、环境和机器人身份登记，未使用个人网页登录。'};
  }
  const blocks=[];let pageToken='';const seen=new Set();
  do{
   if(seen.has(pageToken))throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','在线文档分页令牌重复，不能声明完整读取。');seen.add(pageToken);
   const page=await request(`/open-apis/docx/v1/documents/${token}/blocks`,{page_size:500,...(pageToken?{page_token:pageToken}:{})});
   if(!Array.isArray(page.items))throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','在线文档正文结构不完整，不能当作空文档。');blocks.push(...page.items);
   pageToken=page.has_more?String(page.page_token??''):'';if(page.has_more&&!pageToken)throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','在线文档分页缺少下一页令牌。');
  }while(pageToken);
  return {nativeDocument:true,documentType,title,readAt:new Date().toISOString(),identity:'originating_bot',documentToken:token,content:documentBlocksText(blocks),blocks,note:'已按飞书文档分页完整读取；复杂嵌入对象保留在 blocks 证据中，正文文本不等于附件、图片或公式的视觉内容。'};
 }
 if(tool==='read_cloud_document')throw new CloudSheetError('CLOUD_DOCUMENT_INPUT','当前节点是电子表格；请使用 read_cloud_sheet。');
 const {sheets}=await request('/open-apis/sheets/v3/spreadsheets/'+token+'/sheets/query');
 if(!Array.isArray(sheets))throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','电子表格元数据不完整，不能当作空表。');
 if(tool==='connection'){if(Object.keys(args).length)throw invalid();return {nativeDocument:true,title,readAt:new Date().toISOString(),identity:'originating_bot',sheets:sheets.map(s=>({sheetId:s.sheet_id,title:s.title,hidden:s.hidden,rowCount:s.grid_properties?.row_count,columnCount:s.grid_properties?.column_count})),note:'完整行列范围来自表格元数据，不是非空业务记录数。用read_cloud_sheet分页读取；保留空值、重复项和原始行号，未读范围不是无数据。'}};
 if(Object.keys(args).some(k=>!['sheetId','startRow','endRow','startColumn','endColumn'].includes(k)))throw invalid();
 const sheet=sheets.find(s=>s.sheet_id===args.sheetId);if(!sheet)throw invalid();
 const {startRow,endRow,startColumn=1,endColumn=sheet.grid_properties?.column_count}=args;
 if(!/^[A-Za-z0-9]+$/.test(sheet.sheet_id)||![startRow,endRow,startColumn,endColumn].every(Number.isSafeInteger)||startRow<1||endRow<startRow||endRow>sheet.grid_properties.row_count||startColumn<1||endColumn<startColumn||endColumn>sheet.grid_properties.column_count)throw invalid();
 const range=sheet.sheet_id+'!'+column(startColumn)+startRow+':'+column(endColumn)+endRow;
 const data=await request('/open-apis/sheets/v2/spreadsheets/'+token+'/values/'+encodeURIComponent(range),{valueRenderOption:'ToString',dateTimeRenderOption:'FormattedString'});
 const v=data.valueRange;if(v?.range!==range||!Array.isArray(v.values)||v.values.some(row=>!Array.isArray(row)||row.length>endColumn-startColumn+1)||v.values.length>endRow-startRow+1)throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','返回范围或单元格结构不符，不能声明完整读取。');
 return {nativeDocument:true,sheetId:sheet.sheet_id,range,revision:data.revision??null,readAt:new Date().toISOString(),startRow,endRow,startColumn,endColumn,gridRows:sheet.grid_properties.row_count,gridColumns:sheet.grid_properties.column_count,values:v.values,nextRow:endRow<sheet.grid_properties.row_count?endRow+1:null,nextColumn:endColumn<sheet.grid_properties.column_count?endColumn+1:null,completeRange:true,wholeSheet:startRow===1&&endRow===sheet.grid_properties.row_count&&startColumn===1&&endColumn===sheet.grid_properties.column_count,note:'原始单元格值；无自动表头、去重、补零或数据类型猜测。多次读取不保证同一事务，必须核对revision/readAt。'};
}

// Import actual task-bound native input bytes. The model chooses column indices,
// never rows, source hashes, arbitrary paths or JSON code to execute.
export function nativeInputDataset(attachment,bytes,args,job){
 const bad=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};
 if(attachment?.source?.jobId&&attachment.source.jobId!==job.id)bad('原生输入不属于当前任务');
 if(!attachment||attachment.source?.kind!=='authorized-native-cloud-sheet'||attachment.contentType!=='application/json'||attachment.source.originProfile&&attachment.source.originProfile!==job.originProfile||attachment.source.projectId&&attachment.source.projectId!==job.projectId||attachment.source.tier&&job.environmentAccess?.tier&&attachment.source.tier!==job.environmentAccess.tier)bad('只允许导入当前任务原机器人已登记的原生表格输入；不是任意附件路径或其他系统数据。');
 if(createHash('sha256').update(bytes).digest('hex')!==attachment.source.sha256)bad('输入文件摘要与登记记录不符');
 let raw;try{raw=JSON.parse(bytes);}catch{bad('输入JSON无效');}const v=raw.data?.valueRange,values=v?.values;
 if(attachment.source.range&&v?.range!==attachment.source.range)bad('输入范围与登记记录不一致');
 if(!Array.isArray(values)||values.length!==attachment.source.rows||values.some(row=>!Array.isArray(row)||row.length>attachment.source.columns)||raw.data.revision!==attachment.source.revision)bad('原生输入范围、行列或revision与已保存证据不符；不能当作完整数据。');
 if(Object.keys(args).some(k=>!['attachmentId','columns','rowKey'].includes(k)))bad('不支持的输入导入参数');
 const fields=args.columns,key=args.rowKey??'input_row';const name=x=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x)&&!['__proto__','prototype','constructor'].includes(x);
 if(!Array.isArray(fields)||!fields.length||!name(key)||fields.some(f=>Object.keys(f).some(k=>!['index','as','type','normalization'].includes(k))||!['string',undefined].includes(f.type)||!['none','integer_decimal',undefined].includes(f.normalization)||f.normalization!==undefined&&f.type!=='string'||!Number.isSafeInteger(f.index)||f.index<0||f.index>=attachment.source.columns||!name(f.as))||new Set([key,...fields.map(f=>f.as)]).size!==fields.length+1)bad('明确原始0-based列索引、唯一输出列名和独立行号列；不自动猜表头或去重。');
 const rows=values.map((cells,index)=>{const row={[key]:String(index+1)};for(const f of fields){const value=cells[f.index]??null;if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isSafeInteger(value)))bad('输入包含无法精确解释的数字或复杂单元格；不能丢精度或猜测金额。');row[f.as]=f.type==='string'?exactText(value,f.normalization):value;}return row;});
 const capturedAt=new Date().toISOString(),readAt=attachment.source.readAt??capturedAt;
 return {rows,columns:[key,...fields.map(f=>f.as)],numericColumns:[],complete:true,readAt,sourceRead:{kind:'task_input',...(attachment.source.sourceReads?{sourceReads:attachment.source.sourceReads,sameTransactionSnapshot:false}:{}),readAtKnown:Boolean(attachment.source.readAt),capturedAt,revision:attachment.source.revision},inputEvidence:{version:fields.some(f=>f.type)?2:1,kind:'native-cloud-sheet',attachmentId:attachment.id,sha256:attachment.source.sha256,rowCount:rows.length,rowKey:key,columns:fields.map(f=>({...f})),revision:attachment.source.revision,scope:{jobId:job.id,projectId:job.projectId,originProfile:job.originProfile,sourceEnvironment:job.sourceEnvironment}}};
}

export async function registerCloudSheetInput(store,dataDir,job,environment,result){
 if(!result.nativeDocument)return result;
 if(result.wholeSheet!==true){try{return await collectCloudSheetPage(store,dataDir,job,environment,result,registerCloudSheetInput);}catch(error){if(error.code==='CLOUD_DOCUMENT_INPUT')throw new CloudSheetError(error.code,error.message);throw error;}}
 if(!Array.isArray(result.values)||result.values.length!==result.gridRows)throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','原生表格未返回声明范围的全部行；不能登记为完整输入。');
 const {mkdir,writeFile,lstat,readFile}=await import('node:fs/promises'),path=await import('node:path');
 const body=Buffer.from(JSON.stringify({data:{revision:result.revision,valueRange:{range:result.range,values:result.values}}})),sha256=createHash('sha256').update(body).digest('hex');
 const binding=createHash('sha256').update(JSON.stringify([job.id,job.projectId,job.originProfile,environment.tier,result.range,result.revision,sha256])).digest('hex'),id='ATT-cloud-'+binding;
 const parent=path.join(dataDir,'attachments');await mkdir(parent,{recursive:true,mode:0o700});if((await lstat(parent)).isSymbolicLink())throw Error('Linked cloud input directory');const dir=path.join(parent,createHash('sha256').update(job.id).digest('hex'));await mkdir(dir,{recursive:true,mode:0o700});if((await lstat(dir)).isSymbolicLink())throw Error('Linked cloud input directory');
 const file=path.join(dir,id+'.json');try{if((await lstat(file)).isSymbolicLink())throw Error('Linked cloud input file');}catch(error){if(error.code!=='ENOENT')throw error;}try{await writeFile(file,body,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw error;}
 const attachment={id,type:'file',contentType:'application/json',path:file,source:{kind:'authorized-native-cloud-sheet',originProfile:job.originProfile,projectId:job.projectId,tier:environment.tier,jobId:job.id,...(result.sourceReads?{sourceReads:result.sourceReads,sameTransactionSnapshot:false}:{}),rows:result.gridRows,columns:result.gridColumns,revision:result.revision,readAt:result.readAt,range:result.range,sha256}};
 const accepted=await store.transact(state=>{const current=state.jobs.find(x=>x.id===job.id);if(!job.lease?.id||current?.status!=='running'||!current.lease?.id||current.lease.id!==job.lease.id||current.originProfile!==job.originProfile||current.projectId!==job.projectId||job.environmentAccess?.scopeHash&&current.environmentAccess?.scopeHash!==job.environmentAccess.scopeHash)throw Error('Cloud input task or lease changed');try{assertCloudSheetPageSet(current,result.cloudSheetPageSet);}catch(error){throw new CloudSheetError(error.code,error.message);}current.attachments??=[];const previous=current.attachments.find(x=>x.id===id);if(previous&&(previous.source.sha256!==sha256||previous.path!==file||previous.source.originProfile!==job.originProfile))throw Error('Cloud input binding changed');if(!previous)current.attachments.push(attachment);return previous??attachment;});
 const {values,cloudSheetPageSet,...metadata}=result;return{...metadata,complete:true,inputAttachment:{id,type:attachment.type,contentType:accepted.contentType,source:accepted.source},preview:values.slice(0,3),note:'完整原始表格已作为当前任务输入持久化，无需逐页抄录工具结果。下一数据库环境使用import_task_input导入这个attachmentId，再collect_dataset_values建立完整in_set；保留原顺序、重复与空值，尚未核验业务记录。'};
}

export async function registerCloudDocumentInput(store,dataDir,job,environment,result){
 if(!result.nativeDocument||!['file','docx'].includes(result.documentType))return result;
 const {mkdir,writeFile,lstat,readFile}=await import('node:fs/promises'),path=await import('node:path');
 const fileBytes=Buffer.isBuffer(result.fileBytes)?result.fileBytes:Buffer.from(JSON.stringify({title:result.title,documentToken:result.documentToken,blocks:result.blocks,content:result.content}));
 const sha256=createHash('sha256').update(fileBytes).digest('hex'),extension=result.documentType==='file'&&/^[a-z0-9]{1,10}$/.test(result.extension??'')?'.'+result.extension:'.json';
 const binding=createHash('sha256').update(JSON.stringify([job.id,job.projectId,job.originProfile,environment.tier,result.documentType,result.fileToken??result.documentToken,result.title,sha256])).digest('hex'),id='ATT-cloud-'+binding;
 const parent=path.join(dataDir,'attachments');await mkdir(parent,{recursive:true,mode:0o700});if((await lstat(parent)).isSymbolicLink())throw Error('Linked cloud input directory');
 const dir=path.join(parent,createHash('sha256').update(job.id).digest('hex'));await mkdir(dir,{recursive:true,mode:0o700});if((await lstat(dir)).isSymbolicLink())throw Error('Linked cloud input directory');
 const file=path.join(dir,id+extension);try{if((await lstat(file)).isSymbolicLink())throw Error('Linked cloud input file');}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await writeFile(file,fileBytes,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw error;}
 const attachment={id,type:'file',contentType:result.contentType??'application/json',path:file,source:{kind:result.documentType==='file'?'authorized-native-cloud-file':'authorized-native-cloud-document',originProfile:job.originProfile,projectId:job.projectId,tier:environment.tier,jobId:job.id,documentType:result.documentType,title:result.title??null,token:result.fileToken??result.documentToken,readAt:result.readAt,sha256}};
 const accepted=await store.transact(state=>{const current=state.jobs.find(x=>x.id===job.id);if(!job.lease?.id||current?.status!=='running'||!current.lease?.id||current.lease.id!==job.lease.id||current.originProfile!==job.originProfile||current.projectId!==job.projectId||job.environmentAccess?.scopeHash&&current.environmentAccess?.scopeHash!==job.environmentAccess.scopeHash)throw Error('Cloud input task or lease changed');current.attachments??=[];const previous=current.attachments.find(x=>x.id===id);if(previous&&(previous.source.sha256!==sha256||previous.path!==file||previous.source.originProfile!==job.originProfile))throw Error('Cloud input binding changed');if(!previous)current.attachments.push(attachment);return previous??attachment;});
 const {fileBytes:_fileBytes,blocks:_blocks,...metadata}=result;
 return {...metadata,complete:true,inputAttachment:{id,type:accepted.type,contentType:accepted.contentType,source:accepted.source},note:result.note+' 原始文件已作为当前任务输入持久化；后续阶段可直接读取该 attachmentId，不要求用户重传。'};
}

export async function restoreCloudSheetInput(store,dataDir,job,environment,args={}){
 if(!args||Array.isArray(args)||Object.keys(args).some(k=>k!=='resultRefs')||!Array.isArray(args.resultRefs)||!args.resultRefs.length||new Set(args.resultRefs).size!==args.resultRefs.length||args.resultRefs.some(x=>!/^tool-result-[a-f0-9-]{36}$/.test(x)))throw invalid();
 if(!cloudSheetTarget(job.environmentAccess?.websiteTarget??environment.baseUrl)||environment.projectId!==job.projectId)throw invalid();
 const {ToolResultStore}=await import('../runner/tool-result-store.js'),{fingerprint}=await import('./environment-access.js'),path=await import('node:path');
 const saved=new ToolResultStore({directory:path.join(dataDir,'exports',job.id),scope:fingerprint(environment)}),pages=[];
 // Validate every requested artifact before mutating registration state.
 for(const ref of args.resultRefs){let record;try{record=await saved.load(ref);}catch{throw new CloudSheetError('CLOUD_DOCUMENT_INPUT','保存结果不存在、越界、摘要损坏或不属于当前任务环境');}if(record.tool!=='read_cloud_sheet')throw invalid();let value;try{value=JSON.parse(record.text);}catch{throw invalid();}if(!value.nativeDocument||!Array.isArray(value.values))throw new CloudSheetError('CLOUD_DOCUMENT_INPUT','引用没有原始表格值；已登记inputAttachment应直接复用其ID');pages.push(value);}
 try{assembleCloudSheetPages(pages);}catch(error){throw new CloudSheetError('CLOUD_DOCUMENT_INPUT',error.message);}
 let result;for(const page of pages)result=await registerCloudSheetInput(store,dataDir,job,environment,page);return {...result,restoredPageCount:pages.length,newPlatformRequest:false};
}
