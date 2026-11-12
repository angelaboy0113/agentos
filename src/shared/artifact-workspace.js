import {fileURLToPath} from 'node:url';
import {mkdir,lstat,realpath,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentDirectory} from './document-artifacts.js';
export const artifactPolicy='task-artifact-workspace-v1';
const fail=()=>{throw Object.assign(new Error('产物路径必须是本任务working内的普通独立文件，禁止链接、越界和共享inode'),{code:'ARTIFACT_BOUNDARY'});};
export async function prepareArtifactWorkspace(dataDir,jobId){
 const parent=await documentDirectory(dataDir,jobId),directory=path.join(parent,'working');
 try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(directory)!==directory)fail();
 await inspectTree(directory);
 return {policy:artifactPolicy,directory,profile:'aos_artifact_'+createHash('sha256').update(directory).digest('hex').slice(0,20)};
}
async function inspectTree(directory){for(const e of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,e.name),s=await lstat(file);if(s.isSymbolicLink()||await realpath(file)!==file||(!s.isDirectory()&&(!s.isFile()||s.nlink!==1)))fail();if(s.isDirectory())await inspectTree(file);}}
export function artifactPermissionArgs(workspace){
 if(workspace?.policy!==artifactPolicy||!path.isAbsolute(workspace.directory)||!/^aos_artifact_[a-f0-9]{20}$/.test(workspace.profile))fail();
 return ['-c',`permissions.${workspace.profile}={extends=":read-only",filesystem={${JSON.stringify(workspace.directory)}="write"}}`,'-c',`default_permissions=${JSON.stringify(workspace.profile)}`];
}
export async function readArtifactFile(dataDir,jobId,relative){
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'||p==='.git'))fail();
 const workspace=await prepareArtifactWorkspace(dataDir,jobId);let current=workspace.directory;
 for(const part of relative.split('/')){current=path.join(current,part);const s=await lstat(current);if(s.isSymbolicLink()||await realpath(current)!==current)fail();}
 const h=await open(current,'r');try{const s=await h.stat(),named=await lstat(current);if(!s.isFile()||s.nlink!==1||s.ino!==named.ino||s.dev!==named.dev||named.isSymbolicLink())fail();const bytes=await h.readFile();const after=await h.stat();if(after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.nlink!==1)fail();return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};}finally{await h.close();}
}
export function artifactWorkspaceNotice(workspace){return `\n任务产物工作区：${workspace.directory}。这是本轮唯一可写目录，源码/配置/凭据和其他任务仍只读；不要fetch/checkout或修改业务系统。可用程序批量扫描源码、解析上文已校验数据并构建实际文件，不逐条抄写大文档；临时文件也放在此目录。已安装Node依赖只读位置：${path.resolve(new URL('../../node_modules',import.meta.url).pathname)}。接口目录HTML优先复用发行包生成器 ${fileURLToPath(new URL('../../scripts/render-interface-document.mjs',import.meta.url))}：node 该脚本 本working目录 input.json output.html。输入为{title,scope,sections:[{title,text}],endpoints:[{id,service,method,path,category,description,plain,status,request,response,source,modelIds:[]}],models:[{id,definition,source}]}；文字/编号/路径保持字符串，集中模型只存一份并由modelIds引用，不重复铺开同一模型/方法全文。它不扫描或猜业务事实，只排版已核实结构化数据，保持全接口数量与缺项，缺事实不得填虚构值。先保存可重用的结构化目录和证据，独立取证可批量读取，增量合并变化；用户未要求草稿时，优先在相关证据收齐或真实缺口明确后集中构建最终文件，避免每查一个平台重写整份大HTML。这不是禁止草稿或任务轮次限制。完成后documentRequests中content可填{artifactFile:相对此目录的文件名,sourceFile:生成脚本相对路径或null}，不必把整份HTML/数千行放入最终JSON。程序会复制、检查和哈希登记后投递。实际HTML/PDF/PNG浏览器渲染由可信运行器完成；PPTX/DOCX配置Office预览后会在contentAudit.preview提供与原文件SHA绑定的逐页图片，必须逐张查看，未配置/失败则明确缺口，不把结构检查冒充视觉验收。请求生成文档时可先用partial、已通过的数据/结构检查及明确风险提交documentRequests，即使尚无report工件，运行器也会先登记实际文件再执行同一交接核验；不得将待渲染或待投递说成完整交付。不要求你在只读沙箱内启动Chromium；此类启动若被沙箱拒绝，提交documentRequests让内置渲染器核验，不因本地浏览器进程权限反复重试或停止文件交付。可在事实核对接续轮先提交清楚标注范围的草稿供运行器核验，不能把草稿称为最终交付。HTML必须自包含且无需外部网络，业务表格沿用原CSV独立核验，不得用自行拼接文件绕过。`;}
