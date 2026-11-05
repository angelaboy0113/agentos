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
