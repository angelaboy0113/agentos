import {createHash} from 'node:crypto';
// Platform adapter: explicit task document only, GET-only, originating bot identity.
export function cloudSheetTarget(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(u.hostname))return null;
 const m=/^\/(wiki|sheets)\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);return m?{kind:m[1],token:m[2]}:null;}catch{return null;}
}
export function cloudReadRoute(route){return route==='/open-apis/wiki/v2/spaces/get_node'||/^\/open-apis\/sheets\/v3\/spreadsheets\/[A-Za-z0-9]+\/sheets\/query$/.test(route)||/^\/open-apis\/sheets\/v2\/spreadsheets\/[A-Za-z0-9]+\/values\/[A-Za-z0-9]+(?:!|%21)[A-Z]+[0-9]+%3A[A-Z]+[0-9]+$/i.test(route);}
export class CloudSheetError extends Error{constructor(code,message){super(message);this.code=code;this.statusCode=400;}}
const invalid=()=>new CloudSheetError('CLOUD_DOCUMENT_INPUT','使用当前文档元数据返回的sheetId和有效行列范围；此工具只读取本任务已批准的表格，不接受其他URL。');
const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
export async function readCloudSheet(client,job,environment,tool,args={}){
 const url=job.environmentAccess?.websiteTarget??environment.baseUrl,target=cloudSheetTarget(url);
 if(!target||environment.kind!=='website'||environment.projectId!==job.projectId||!job.originProfile)throw invalid();
 if(!['connection','read_cloud_sheet'].includes(tool)||!args||Array.isArray(args)||typeof args!=='object')throw invalid();
 const request=async(route,params={})=>{if(!cloudReadRoute(route))throw invalid();try{return await client.cloudRequest(route,params,{profile:job.originProfile});}catch(error){if(error instanceof CloudSheetError)throw error;const message=String(error.message??'');const scope=message.includes('app_scope_not_applied')||message.includes('99991672');throw new CloudSheetError(scope?'CLOUD_DOCUMENT_SCOPE':'CLOUD_DOCUMENT_ACCESS',scope?'机器人应用尚缺知识库节点或电子表格只读权限；请维护者核对应用权限。不是个人网页登录失败。':'机器人未能读取该文档；请核对文档是否对当前机器人开放、应用权限和平台网络。不需要在群里发送个人账号密码。');}};
 let token=target.token,title=null;
 if(target.kind==='wiki'){const node=(await request('/open-apis/wiki/v2/spaces/get_node',{token})).node;if(node?.obj_type!=='sheet'||!/^[A-Za-z0-9]+$/.test(node.obj_token??''))throw new CloudSheetError('CLOUD_DOCUMENT_TYPE','此知识库节点不是电子表格；未尝试用表格接口或业务网页登录读取其他类型。');token=node.obj_token;title=node.title;}
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
 if(!attachment||attachment.source?.kind!=='authorized-native-cloud-sheet'||attachment.contentType!=='application/json'||attachment.source.originProfile&&attachment.source.originProfile!==job.originProfile||attachment.source.projectId&&attachment.source.projectId!==job.projectId||attachment.source.tier&&job.environmentAccess?.tier&&attachment.source.tier!==job.environmentAccess.tier)bad('只允许导入当前任务原机器人已登记的原生表格输入；不是任意附件路径或其他系统数据。');
 if(createHash('sha256').update(bytes).digest('hex')!==attachment.source.sha256)bad('输入文件摘要与登记记录不符');
 let raw;try{raw=JSON.parse(bytes);}catch{bad('输入JSON无效');}const v=raw.data?.valueRange,values=v?.values;
 if(attachment.source.range&&v?.range!==attachment.source.range)bad('输入范围与登记记录不一致');
 if(!Array.isArray(values)||values.length!==attachment.source.rows||values.some(row=>!Array.isArray(row)||row.length>attachment.source.columns)||raw.data.revision!==attachment.source.revision)bad('原生输入范围、行列或revision与已保存证据不符；不能当作完整数据。');
 const fields=args.columns,key=args.rowKey??'input_row';const name=x=>typeof x==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x)&&!['__proto__','prototype','constructor'].includes(x);
 if(!Array.isArray(fields)||!fields.length||!name(key)||fields.some(f=>!Number.isSafeInteger(f.index)||f.index<0||f.index>=attachment.source.columns||!name(f.as))||new Set([key,...fields.map(f=>f.as)]).size!==fields.length+1)bad('明确原始0-based列索引、唯一输出列名和独立行号列；不自动猜表头或去重。');
 const rows=values.map((cells,index)=>{const row={[key]:String(index+1)};for(const f of fields){const value=cells[f.index]??null;if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isSafeInteger(value)))bad('输入包含无法精确解释的数字或复杂单元格；不能丢精度或猜测金额。');row[f.as]=value;}return row;});
 const capturedAt=new Date().toISOString(),readAt=attachment.source.readAt??capturedAt;
 return {rows,columns:[key,...fields.map(f=>f.as)],numericColumns:[],complete:true,readAt,sourceRead:{kind:'task_input',readAtKnown:Boolean(attachment.source.readAt),capturedAt,revision:attachment.source.revision},inputEvidence:{version:1,kind:'native-cloud-sheet',attachmentId:attachment.id,sha256:attachment.source.sha256,rowCount:rows.length,rowKey:key,columns:fields.map(f=>({...f})),revision:attachment.source.revision,scope:{jobId:job.id,projectId:job.projectId,originProfile:job.originProfile,sourceEnvironment:job.sourceEnvironment}}};
}

export async function registerCloudSheetInput(store,dataDir,job,environment,result){
 if(!result.nativeDocument||result.wholeSheet!==true)return result;
 if(!Array.isArray(result.values)||result.values.length!==result.gridRows)throw new CloudSheetError('CLOUD_DOCUMENT_RESPONSE','原生表格未返回声明范围的全部行；不能登记为完整输入。');
 const {mkdir,writeFile,lstat,readFile}=await import('node:fs/promises'),path=await import('node:path');
 const body=Buffer.from(JSON.stringify({data:{revision:result.revision,valueRange:{range:result.range,values:result.values}}})),sha256=createHash('sha256').update(body).digest('hex');
 const binding=createHash('sha256').update(JSON.stringify([job.id,job.projectId,job.originProfile,environment.tier,result.range,result.revision,sha256])).digest('hex'),id='ATT-cloud-'+binding;
 const parent=path.join(dataDir,'attachments');await mkdir(parent,{recursive:true,mode:0o700});if((await lstat(parent)).isSymbolicLink())throw Error('Linked cloud input directory');const dir=path.join(parent,createHash('sha256').update(job.id).digest('hex'));await mkdir(dir,{recursive:true,mode:0o700});if((await lstat(dir)).isSymbolicLink())throw Error('Linked cloud input directory');
 const file=path.join(dir,id+'.json');try{if((await lstat(file)).isSymbolicLink())throw Error('Linked cloud input file');}catch(error){if(error.code!=='ENOENT')throw error;}try{await writeFile(file,body,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw error;}
 const attachment={id,type:'file',contentType:'application/json',path:file,source:{kind:'authorized-native-cloud-sheet',originProfile:job.originProfile,projectId:job.projectId,tier:environment.tier,rows:result.gridRows,columns:result.gridColumns,revision:result.revision,readAt:result.readAt,range:result.range,sha256}};
 const accepted=await store.transact(state=>{const current=state.jobs.find(x=>x.id===job.id);if(!job.lease?.id||current?.status!=='running'||!current.lease?.id||current.lease.id!==job.lease.id||current.originProfile!==job.originProfile||current.projectId!==job.projectId)throw Error('Cloud input task or lease changed');current.attachments??=[];const previous=current.attachments.find(x=>x.id===id);if(previous&&(previous.source.sha256!==sha256||previous.path!==file||previous.source.originProfile!==job.originProfile))throw Error('Cloud input binding changed');if(!previous)current.attachments.push(attachment);return previous??attachment;});
 const {values,...metadata}=result;return{...metadata,complete:true,inputAttachment:{id,type:attachment.type,contentType:accepted.contentType,source:accepted.source},preview:values.slice(0,3),note:'完整原始表格已作为当前任务输入持久化，无需逐页抄录工具结果。下一数据库环境使用import_task_input导入这个attachmentId，再collect_dataset_values建立完整in_set；保留原顺序、重复与空值，尚未核验业务记录。'};
}
