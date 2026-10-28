import {mkdir,writeFile,readFile,lstat,realpath,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
const valid=s=>typeof s==='string'&&/^tool-result-[a-f0-9-]{36}$/.test(s);
const bad=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};

// Opaque references only. The leased job fixes the directory and current environment
// fixes the scope. Presentation pagination never changes business completeness.
export class ToolResultStore{
 constructor({directory,scope,authorize=async()=>{},secrets=[]}){this.directory=directory;this.scope=scope;this.authorize=authorize;this.secrets=secrets.filter(Boolean);this.memory=new Map();}
 async root(){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  if(!(await lstat(this.directory)).isDirectory()||(await lstat(this.directory)).isSymbolicLink())bad('工具结果目录无效');
  const root=path.join(this.directory,'tool-results');await mkdir(root,{recursive:true,mode:0o700});
  if(!(await lstat(root)).isDirectory()||(await lstat(root)).isSymbolicLink())bad('工具结果目录不能是符号链接');return realpath(root);
 }
 async present(tool,result,maxBytes=24000){
  const text=JSON.stringify(result,(_key,value)=>typeof value==='string'?this.secrets.reduce((v,s)=>v.split(s).join('[已隐藏]'),value):value);
  if(Buffer.byteLength(text)<=maxBytes)return JSON.parse(text);
  await this.authorize();const ref='tool-result-'+randomUUID(),saved={ref,scope:this.scope,tool,createdAt:new Date().toISOString(),sha256:hash(text),text};
  if(this.directory){const root=await this.root();await writeFile(path.join(root,ref+'.json'),JSON.stringify(saved),{mode:0o600,flag:'wx'});}else this.memory.set(ref,saved);
  await this.authorize();
  const out={resultStored:true,resultRef:ref,resultLimited:true,totalCharacters:text.length,bytes:Buffer.byteLength(text),sha256:saved.sha256,omittedFields:[],note:'本次工具返回已完整保存；展示分页不改变原查询完整性，仍须遵循原始partial/complete。read_tool_result按resultRef和offset续读，不重查或重算已完成步骤。'};
  for(const [key,value]of Object.entries(result)){
   if(value===undefined)continue;
   if(Buffer.byteLength(JSON.stringify(value))<=3000&&Buffer.byteLength(JSON.stringify(out))+Buffer.byteLength(JSON.stringify({[key]:value}))<16000)out[key]=JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='string'?this.secrets.reduce((x,s)=>x.split(s).join('[已隐藏]'),v):v));
   else out.omittedFields.push(key);
  }
  // A missing long stage cannot turn a failed or partial tool into success.
  for(const key of ['partial','complete','truncated','loginRequired','websiteMismatch'])if(typeof result[key]==='boolean')out[key]=result[key];
  return out;
 }
 async list({offset=0,limit=20}={}){
  await this.authorize();if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)bad('工具结果目录分页无效');
  const items=[];
  if(this.directory){
   const root=await this.root();
   for(const name of await readdir(root))if(name.endsWith('.json')&&valid(name.slice(0,-5))){try{const saved=await this.load(name.slice(0,-5));items.push(saved);}catch{/* Foreign, linked or corrupt files cannot enter the catalog. */}}
  }else items.push(...this.memory.values());
  const all=items.filter(x=>x.scope===this.scope).map(x=>({resultRef:x.ref,tool:x.tool,createdAt:x.createdAt,totalCharacters:x.text.length,sha256:x.sha256})).sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??''));
  await this.authorize();return {items:all.slice(offset,offset+limit),totalCount:all.length,nextOffset:offset+limit<all.length?offset+limit:null,note:'当前任务、当前环境的完整工具结果引用；历史结果不是新取数。'};
 }
 async load(resultRef){
  let saved=this.memory.get(resultRef);
  if(this.directory){const root=await this.root(),file=path.join(root,resultRef+'.json');let st,actual;
   try{st=await lstat(file);actual=await realpath(file);}catch(error){if(error.code==='ENOENT')bad('工具结果引用不存在');throw error;}
   if(!st.isFile()||st.isSymbolicLink()||!actual.startsWith(root+path.sep))bad('工具结果文件越界');
   try{saved=JSON.parse(await readFile(file,'utf8'));}catch{bad('工具结果文件无法核验');}
  }
  if(!saved||saved.scope!==this.scope||saved.ref!==resultRef||hash(saved.text)!==saved.sha256)bad('工具结果范围或内容摘要无效');return saved;
 }
 async read({resultRef,offset=0,limit=4000}){
  await this.authorize();if(!valid(resultRef)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>4000)bad('工具结果引用无效；offset须非负，limit为1至4000字符');
  const saved=await this.load(resultRef);if(offset>saved.text.length)bad('工具结果分页位置无效');
  let end=Math.min(offset+limit,saved.text.length);if(end<saved.text.length&&/[\uD800-\uDBFF]/.test(saved.text[end-1]))end--;
  if(end===offset&&offset<saved.text.length)end=Math.min(offset+2,saved.text.length);
  await this.authorize();return {resultRef,tool:saved.tool,text:saved.text.slice(offset,end),offset,nextOffset:end<saved.text.length?end:null,totalCharacters:saved.text.length,sha256:saved.sha256,note:'原结果JSON文本分段，未执行新查询；按nextOffset继续，不能把单段当完整结果。'};
 }
}
