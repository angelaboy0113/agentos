import {currentUserQuestion} from './user-request-scope.js';
import {mkdir,writeFile,readFile,lstat,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
export const documentFormats=['html','pptx','docx','pdf','png','xlsx','json','txt','md','csv','svg','zip'];
export const documentMime={html:'text/html',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf',png:'image/png',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',json:'application/json',txt:'text/plain',md:'text/markdown',csv:'text/csv',svg:'image/svg+xml',zip:'application/zip'};
const fail=m=>{throw Object.assign(new Error(m),{code:'DOCUMENT_INPUT'});};
const text=v=>{if(typeof v!=='string')fail('文档文字必须为字符串，金额和长编号禁止自动转成浮点数');return v;};
const esc=v=>text(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const parse=s=>{try{return JSON.parse(s);}catch{fail('该格式需要有效JSON内容，不能只改扩展名');}};
const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
export function offlineHtml(content){
 text(content);if(!content.trim())fail('HTML内容为空');
 // Put policy ahead of every model-supplied node, including head/meta/script.
 content=content.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[\s\S]*?>/gi,'');
 return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,"PingFang SC",sans-serif;margin:24px;line-height:1.55;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}pre{white-space:pre-wrap}img{max-width:100%}@media print{body{margin:0}}</style></head><body>'+content+'</body></html>';
}
async function visual(html,format){
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true});
 try{const ctx=await browser.newContext({javaScriptEnabled:false,acceptDownloads:false,viewport:{width:1280,height:900}});await ctx.route('**/*',r=>r.abort());const p=await ctx.newPage();await p.setContent(html,{waitUntil:'load'});const content=await p.locator('body').innerText();if(!content.trim())fail('实际渲染内容为空');const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);if(overflow)fail('文档横向溢出，需调整布局后再生成');if(format==='check')return {visible:true,overflow:false};return format==='pdf'?await p.pdf({format:'A4',printBackground:true,margin:{top:'16mm',bottom:'16mm',left:'12mm',right:'12mm'}}):await p.screenshot({fullPage:true,type:'png'});}finally{await browser.close();}
}
async function encode(format,content){
 if(format==='html'){const html=offlineHtml(content);await visual(html,'check');return Buffer.from(html);}
 if(['pdf','png'].includes(format))return visual(offlineHtml(content),format);
 if(['txt','md'].includes(format))return Buffer.from(text(content));
 if(format==='csv'){const {reportCsv}=await import('./report-revision.js');const table=reportCsv(Buffer.from(text(content))),cell=v=>'"'+(/^[\s\uFEFF]*[=+@-]/.test(v)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(v)?"'"+v:v).replaceAll('"','""')+'"';return Buffer.from('\uFEFF'+[table.headers,...table.rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n');}
 if(format==='json'){parse(content);return Buffer.from(content);}
 if(format==='svg'){if(/(?:https?|file|javascript):|@import|url\(\s*[^#]/i.test(content.replace(/xmlns(?::\w+)?=["'][^"']+["']/g,'')))fail('SVG不得含外部地址或脚本');if(!/^\s*<svg[\s>]/.test(content)||/<(?:script|foreignObject)|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#|data:)/i.test(content))fail('SVG需要自包含且无活动外链');return Buffer.from(content);}
 const spec=parse(content);
 if(format==='zip'){if(!Array.isArray(spec.entries)||!spec.entries.length)fail('ZIP需要entries');const {default:JSZip}=await import('jszip');const zip=new JSZip(),seen=new Set();for(const e of spec.entries){if(!/^[\w\u3400-\u9fff .-]+\.(?:txt|md|csv|json|html|svg)$/.test(e.name)||seen.has(e.name))fail('ZIP条目名称无效或重复');seen.add(e.name);zip.file(e.name,await encode(e.name.split('.').at(-1),text(e.content)));}return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
 if(format==='xlsx'){if(!Array.isArray(spec.sheets)||!spec.sheets.length)fail('XLSX需要sheets');const {default:ExcelJS}=await import('exceljs');const wb=new ExcelJS.Workbook();for(const sheet of spec.sheets){const ws=wb.addWorksheet(text(sheet.name));if(!Array.isArray(sheet.rows))fail('工作表缺少rows');for(const row of sheet.rows){if(!Array.isArray(row)||row.some(v=>v!==null&&typeof v!=='string'))fail('工作簿原始单元格必须为字符串或null，避免金额和长编号损失');ws.addRow(row);}ws.views=[{state:'frozen',ySplit:1}];}return Buffer.from(await wb.xlsx.writeBuffer());}
 if(format==='docx'){if(!Array.isArray(spec.sections)||!spec.sections.length)fail('DOCX需要sections');const {Document,Packer,Paragraph,Table,TableRow,TableCell}=await import('docx');const children=[];for(const section of spec.sections){children.push(new Paragraph({text:text(section.title),heading:'Heading1'}));for(const p of section.paragraphs??[])children.push(new Paragraph(text(p)));for(const table of section.tables??[]){children.push(new Table({rows:table.map(row=>new TableRow({children:row.map(v=>new TableCell({children:[new Paragraph(text(v))]}))}))}));}}return Packer.toBuffer(new Document({sections:[{children}]}));}
 if(format==='pptx'){const {renderPresentation}=await import('./presentation-renderer.js');return renderPresentation(spec);}
 fail('未安装该格式渲染器；不能伪造扩展名或擅自替换用户要求');
}
export async function inspectDocumentBytes(format,bytes){
 if(!bytes.length)fail('文件为空');
 if(['pptx','docx','xlsx','zip'].includes(format)){const {default:JSZip}=await import('jszip');const z=await JSZip.loadAsync(bytes,{checkCRC32:true}),names=Object.keys(z.files);if(names.some(n=>n.startsWith('/')||n.split('/').includes('..')||/vbaProject\.bin$/i.test(n)))fail('归档包含危险路径或宏');for(const n of names.filter(n=>n.endsWith('.rels'))){if(/TargetMode=\"External\"/i.test(await z.file(n).async('string')))fail('Office文件不得依赖外部关系');}const required={pptx:'ppt/presentation.xml',docx:'word/document.xml',xlsx:'xl/workbook.xml'}[format];if(required&&!names.includes(required))fail('实际Office文件结构不符');return {format,bytes:bytes.length,entries:names.length,structure:'passed'};}
 if(format==='pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('实际文件不是PDF');
 if(format==='png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail('实际文件不是PNG');
 if(format==='json')parse(bytes.toString());
 if(format==='html'&&!bytes.toString().includes(csp))fail('HTML缺少离线隔离策略');
 return {format,bytes:bytes.length,structure:'passed'};
}
export async function documentDirectory(dataDir,jobId){
 if(!/^[\w-]{1,100}$/.test(jobId))fail('任务编号无效');
 await mkdir(dataDir,{recursive:true});let dir=await realpath(dataDir);
 for(const name of ['exports',jobId]){const next=path.join(dir,name);try{const s=await lstat(next);if(!s.isDirectory()||s.isSymbolicLink())fail('输出目录不能是链接或文件');}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(next,{mode:0o700,recursive:true});}const after=await lstat(next);if(!after.isDirectory()||after.isSymbolicLink()||await realpath(next)!==next)fail('输出目录边界变化');dir=next;}return dir;
}
async function resolveDocumentRequest(dataDir,job,request){
 if(!['xlsx','csv'].includes(request.format))return request;
 if(typeof request.content!=='string'){if(job.tabularDelivery)fail('业务原生表格仍需独立核验CSV来源，不能绕过金额和范围核验');return request;}
 const spec=request.format==='xlsx'?parse(request.content):null;
 const sourceId=spec?.sourceReportId;
 if(!sourceId){if(job.tabularDelivery)fail('业务报表转换需已有核验CSV的sourceReportId，不能跳过独立金额与范围核验');return request;}
 const source=job.reportFiles?.find(f=>f.id===sourceId&&f.filename.endsWith('.csv')&&f.kind!=='document');
 if(!source)fail('转换来源必须是当前任务已经登记并核验的CSV');
 const {inspectReport}=await import('./report-inspection.js'),view=await inspectReport(dataDir,job,{fileId:source.id});
 if(view.calculationAudit?.status!=='passed')fail('来源报表未通过实际内容独立核验');
 const {reportFile}=await import('./report-files.js'),{reportCsv}=await import('./report-revision.js');
 const original=await reportFile(dataDir,source.sourceJobId??job.id,source),table=reportCsv(original.content);
 return {...request,content:JSON.stringify({sheets:[{name:spec.sheetName??'核验数据',rows:[table.headers,...table.rows]}]}),sourceReport:{id:source.id,sourceJobId:source.sourceJobId??job.id,sha256:source.sha256,verificationHash:source.verificationHash}};
}
async function encodeNative(dataDir,job,request){
 const {readArtifactFile}=await import('./artifact-workspace.js');
 const content=request.content;if(!content||typeof content.artifactFile!=='string'||!Object.hasOwn(content,'sourceFile')||Object.keys(content).some(k=>!['artifactFile','sourceFile'].includes(k)))fail('原生产物引用无效');
 const artifact=await readArtifactFile(dataDir,job.id,content.artifactFile);
 const source=content.sourceFile===null?null:await readArtifactFile(dataDir,job.id,content.sourceFile);
 const format=request.format;
 // Apply the same safe text encoders, including CSV formula escaping and HTML offline rendering.
 const bytes=['html','csv','json','txt','md','svg'].includes(format)?await encode(format,artifact.bytes.toString('utf8')):artifact.bytes;
 return {bytes,request:{...request,nativeSource:{sha256:artifact.sha256,...(source?{buildScript:source.bytes.toString('utf8'),buildScriptSha256:source.sha256}:{})}}};
}
export async function createDocuments(dataDir,job,requests){
 if(requests==null)return [];
 if(!Array.isArray(requests)||!requests.length)fail('documentRequests需要非空数组或null');
 const directory=await documentDirectory(dataDir,job.id),files=[];
 try{for(const originalRequest of requests){let request=await resolveDocumentRequest(dataDir,job,originalRequest);if(!documentFormats.includes(request.format))fail('不支持的格式；需安装并验证对应渲染器');text(request.title);text(request.purpose);const native=typeof request.content==='object'?await encodeNative(dataDir,job,request):null;if(native)request=native.request;const bytes=native?.bytes??await encode(request.format,text(request.content)),audit=await inspectDocumentBytes(request.format,bytes),id='report-'+randomUUID(),filename=id+'.'+request.format;
 const item={id,filename,format:request.format,kind:'document',title:request.title,contentType:documentMime[request.format],bytes:bytes.length,sha256:hash(bytes),rowCount:0,complete:true};
 const receipt={version:2,kind:'document',status:'verified',file:item,coverage:{rowCount:0},binding:{jobId:job.id,projectId:job.projectId,profile:job.originProfile??job.agentProfile,questionId:job.questionId,sourceEnvironment:job.sourceEnvironment??null},purpose:request.purpose,contentAudit:audit,businessVerification:'结构和实际文件核验不等于业务金额核验；业务结论沿用任务独立证据与handoff门控',request};
 const body=Buffer.from(JSON.stringify(receipt));await writeFile(path.join(directory,filename),bytes,{mode:0o600,flag:'wx'});await writeFile(path.join(directory,id+'.verification.json'),body,{mode:0o600,flag:'wx'});item.verificationHash=hash(body);files.push(item);
 }return files;}catch(e){for(const f of files)for(const n of [f.filename,f.id+'.verification.json'])await rm(path.join(directory,n),{force:true});throw e;}
}
export async function documentInputText(dataDir,jobId,item){
 const {reportFile}=await import('./report-files.js');const {file}=await reportFile(dataDir,jobId,item,{includeContent:false});const receipt=JSON.parse(await readFile(path.join(path.dirname(file),item.id+'.verification.json'),'utf8'));
 return JSON.stringify({format:item.format,title:item.title,purpose:receipt.purpose,...(receipt.request.nativeSource?{actualFile:file,buildScript:receipt.request.nativeSource.buildScript??null,nativeSource:receipt.request.nativeSource}:{content:receipt.request.content}),sourceSha256:item.sha256,note:'这是已交付实际文件的哈希绑定生成配方；修改应派生新文件，不能改原件。'});
}
export function requestedDocumentFormats(question=''){
 const rules={html:/\bhtml?\b|\bh5\b|网页文件/i,pptx:/\bpptx?\b|幻灯片|演示文稿/i,docx:/\bdocx\b|\bword\b/i,pdf:/\bpdf\b/i,png:/\bpng\b/i,xlsx:/\bxlsx\b/i,json:/\bjson文件\b|(?:生成|输出|导出).{0,8}json/i,md:/markdown|\.md\b/i,svg:/\bsvg\b/i,zip:/\bzip\b/i};
 const clauses=String(question).split(/[，。；\n]/).filter(c=>!/(?:不要|无需|不需要|不必).{0,6}(?:html|h5|ppt|word|pdf|png|xlsx|文件)/i.test(c));
 return Object.entries(rules).filter(([,re])=>clauses.some(c=>re.test(c)&&/(?:生成|输出|产出|提供|给我|做成|制作|导出|整理成|交付|改成|转换|转成|存为|保存为|发我)/i.test(c))).map(([f])=>f);
}
export function documentFailureResult(result,error){
 const code=error.code??'DOCUMENT_RENDER',message=String(error.message);
 return {...result,outcome:'partial',documentFailure:{code,message},handoff:{...result.handoff,returnTo:'none',risks:[...(result.handoff?.risks??[]),'文件生成或实际核验未完成：'+message]},investigation:{...result.investigation,status:'continue',blocker:null,goals:[{id:'original-question',required:true,status:'open',evidence:'文件步骤 '+code+'：'+message}],nextStep:'保留现有业务证据与产物工作区，修正文件构建或布局后重新提交documentRequests；内置渲染器完成实际核验，不重新业务查询。'},finalMessage:result.finalMessage+'\n文件生成或实际核验未完成：'+message+'。已有调查证据保留，不能声称文件已交付。'};
}
export function enforceDocumentOutput(job,result){
 if(result.outcome!=='ready')return result;
 const required=requestedDocumentFormats(currentUserQuestion(job)),files=[...(job.reportFiles??[]),...(result.exportFiles??[])];
 const missing=required.filter(format=>!files.some(f=>f.format===format&&f.verificationHash));
 if(!missing.length)return result;
 return {...result,outcome:'partial',reportReviewRequired:true,handoff:{...result.handoff,returnTo:'none',risks:[...(result.handoff?.risks??[]),'用户要求的实际文件尚未生成并核验']},investigation:{...result.investigation,status:'continue',blocker:null,goals:[{id:'original-question',required:true,status:'open',evidence:'用户要求的实际文件尚缺：'+missing.join(',')}],nextStep:'用documentRequests生成缺少的实际文件，复用已有证据，不重查业务。'},finalMessage:result.finalMessage+'\n用户要求的 '+missing.join('/')+' 文件尚未生成并核验，不能声称已完整交付。'};
}
