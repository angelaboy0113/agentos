import {createHash} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'CLOUD_DOCUMENT_INPUT',statusCode:400});};
const column=n=>{let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const pageIdentity=p=>JSON.stringify([p.sheetId,p.gridRows,p.gridColumns,p.revision,p.startRow,p.endRow,p.startColumn,p.endColumn,p.values]);
function validate(p){
 if(!p?.nativeDocument||p.completeRange!==true||!Array.isArray(p.values)||!/^[A-Za-z0-9]+$/.test(p.sheetId??'')||![p.gridRows,p.gridColumns,p.startRow,p.endRow,p.startColumn,p.endColumn].every(Number.isSafeInteger)||p.gridRows<1||p.gridColumns<1||!Number.isSafeInteger(p.gridRows+1)||!Number.isSafeInteger(p.gridColumns+1)||p.startRow<1||p.endRow<p.startRow||p.endRow>p.gridRows||p.startColumn<1||p.endColumn<p.startColumn||p.endColumn>p.gridColumns||p.values.length!==p.endRow-p.startRow+1||p.values.some(r=>!Array.isArray(r)||r.length>p.endColumn-p.startColumn+1)||p.range!==p.sheetId+'!'+column(p.startColumn)+p.startRow+':'+column(p.endColumn)+p.endRow||typeof p.readAt!=='string'||!Number.isFinite(Date.parse(p.readAt)))fail('分页范围、实际行数或原读取时间不完整；不能登记或补齐为完整表格。');
}
export function assembleCloudSheetPages(pages){
 if(!pages.length)fail('没有已保存的表格分页');pages.forEach(validate);const first=pages[0];
 if(pages.some(p=>p.sheetId!==first.sheetId||p.gridRows!==first.gridRows||p.gridColumns!==first.gridColumns||p.revision!==first.revision))fail('不同工作表、网格或版本的分页不能合并');
 if(pages.length>1&&first.revision==null)fail('分页缺少可信revision，不能把多轮读取拼为同一版本；请取得完整单次输入或可信版本。');
 const coverage=pageCoverage(pages);if(!coverage.complete)return coverage;
 const values=Array.from({length:first.gridRows},()=>[]);
 for(const p of pages)for(let row=p.startRow;row<=p.endRow;row++)for(let col=p.startColumn;col<=p.endColumn;col++){const target=values[row-1],value=p.values[row-p.startRow][col-p.startColumn]??null;if(Object.hasOwn(target,col-1)&&JSON.stringify(target[col-1])!==JSON.stringify(value))fail('相同revision的重叠分页单元格冲突；保留原证据，请核实版本并重新读取，不能静默取首条。');target[col-1]=value;}
 const sourceReads=pages.map(p=>({range:p.range,readAt:p.readAt})).sort((a,b)=>a.readAt.localeCompare(b.readAt)||a.range.localeCompare(b.range));
 return {...first,values,startRow:1,endRow:first.gridRows,startColumn:1,endColumn:first.gridColumns,range:first.sheetId+'!A1:'+column(first.gridColumns)+first.gridRows,wholeSheet:true,completeRange:true,nextRow:null,nextColumn:null,readAt:sourceReads.at(-1).readAt,sourceReads,sameTransactionSnapshot:false,complete:true};
}
function pageCoverage(pages){const first=pages[0];if(pages.length>1&&first.revision==null)fail('分页缺少可信revision，不能拼接多轮读取');
 const edges=[...new Set([1,first.gridRows+1,...pages.flatMap(p=>[p.startRow,p.endRow+1])])].sort((a,b)=>a-b),missing=[];
 for(let i=0;i<edges.length-1;i++){const start=edges[i],end=edges[i+1]-1,spans=pages.filter(p=>p.startRow<=start&&p.endRow>=end).map(p=>[p.startColumn,p.endColumn]).sort((a,b)=>a[0]-b[0]);let next=1;for(const [left,right]of spans){if(left>next)missing.push({startRow:start,endRow:end,startColumn:next,endColumn:left-1});next=Math.max(next,right+1);}if(next<=first.gridColumns)missing.push({startRow:start,endRow:end,startColumn:next,endColumn:first.gridColumns});}
 return {complete:missing.length===0,receivedParts:pages.length,missingRangeCount:missing.length,missingRanges:missing.slice(0,20),missingRangesLimited:missing.length>20};
}
async function directory(p){await mkdir(p,{recursive:true,mode:0o700});if(!(await lstat(p)).isDirectory()||(await lstat(p)).isSymbolicLink())fail('表格分页目录不能是符号链接');return realpath(p);}
function current(state,job){const j=state.jobs.find(x=>x.id===job.id);if(!job.lease?.id||j?.status!=='running'||j.lease?.id!==job.lease.id||j.originProfile!==job.originProfile||j.projectId!==job.projectId||job.environmentAccess?.scopeHash&&j.environmentAccess?.scopeHash!==job.environmentAccess.scopeHash)fail('表格分页任务、身份或租约已改变');return j;}
export async function collectCloudSheetPage(store,dataDir,job,environment,result,finalize){
 validate(result);let u;try{u=new URL(job.environmentAccess?.websiteTarget??environment.baseUrl);}catch{fail('缺少当前任务的已授权文档入口');}
 if(environment.projectId!==job.projectId||!job.originProfile||u.protocol!=='https:'||u.username||u.password||u.port||!/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(u.hostname)||!/^\/(wiki|sheets)\/[A-Za-z0-9]+\/?$/.test(u.pathname))fail('表格分页只能属于原任务同机器人、系统及已授权文档');
 const binding=hash(JSON.stringify([job.id,job.originProfile,job.projectId,environment.tier,u.origin+u.pathname,result.sheetId,result.gridRows,result.gridColumns,result.revision??null]));
 const parent=await directory(path.join(dataDir,'attachments')),root=await directory(path.join(parent,hash(job.id))),dir=await directory(path.join(root,'cloud-pages')),id='PAGE-'+hash(binding+'\n'+pageIdentity(result)),file=path.join(dir,id+'.json'),body=Buffer.from(JSON.stringify(result));
 let bytes=body;try{await writeFile(file,body,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail('分页文件不能是符号链接');bytes=await readFile(file);let prior;try{prior=JSON.parse(bytes);}catch{fail('已保存分页JSON损坏');}if(pageIdentity(prior)!==pageIdentity(result))fail('分页内容摘要不一致');}
 const original=JSON.parse(bytes),record={id,path:file,sha256:hash(bytes),range:original.range,readAt:original.readAt,...Object.fromEntries(['sheetId','revision','gridRows','gridColumns','startRow','endRow','startColumn','endColumn'].map(k=>[k,original[k]]))};
 const records=await store.transact(state=>{const j=current(state,job);j.cloudSheetPageSets??={};const set=j.cloudSheetPageSets[binding]??={version:1,binding,sheetId:result.sheetId,revision:result.revision??null,pages:[]};if(set.version!==1)fail('分页登记版本不兼容');const old=set.pages.find(x=>x.id===id);if(old&&JSON.stringify(old)!==JSON.stringify(record))fail('已登记分页摘要改变');if(!old)set.pages.push(record);return structuredClone(set.pages);});
 const coverage=pageCoverage(records);
 if(!coverage.complete){const {values,...summary}=result;return {...summary,complete:false,registeredPage:{id,range:result.range},assembly:coverage,preview:result.values.slice(0,3),note:'分页已按原任务持久保存；尚未覆盖完整工作表，不是完整输入。按assembly缺口继续读取，同revision全覆盖后自动登记inputAttachment，无需逐段抄录。'};}
 const metadata=[];for(const rec of records){if(!/^PAGE-[a-f0-9]{64}$/.test(rec.id)||rec.path!==path.join(dir,rec.id+'.json'))fail('分页路径越界');const stat=await lstat(rec.path);if(!stat.isFile()||stat.isSymbolicLink())fail('分页文件不能是符号链接');const raw=await readFile(rec.path);if(hash(raw)!==rec.sha256)fail('已保存分页摘要校验失败');const page=JSON.parse(raw);if('PAGE-'+hash(binding+'\n'+pageIdentity(page))!==rec.id)fail('分页内容不属于当前文档绑定');metadata.push(page);}
 const assembled=assembleCloudSheetPages(metadata);
 const versionHash=hash(JSON.stringify(records));return finalize(store,dataDir,job,environment,{...assembled,cloudSheetPageSet:{binding,versionHash},sourceReads:records.map(rec=>({range:rec.range,readAt:rec.readAt,sha256:rec.sha256}))});
}
export function assertCloudSheetPageSet(current,marker){if(marker&&(!current.cloudSheetPageSets?.[marker.binding]?.pages||hash(JSON.stringify(current.cloudSheetPageSets[marker.binding].pages))!==marker.versionHash))fail('组装期间分页清单改变，请按最新清单重试，不能登记过时完整输入');}
