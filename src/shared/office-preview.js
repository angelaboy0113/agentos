import {mkdtemp,writeFile,readFile,readdir,rm,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const xml=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const hash=b=>createHash('sha256').update(b).digest('hex');
// Trusted Runner only. Neither executable nor arguments are supplied by a model.
// Office macros/external relationships are rejected by inspectDocumentBytes first.
export async function officePreview(bytes,format,directory,options={}){
 if(!['pptx','docx'].includes(format))return null;
 const sourceSha256=hash(bytes),renderer=options.renderer??process.env.AGENTOS_OFFICE_RENDERER,rasterizer=options.rasterizer??process.env.AGENTOS_PDF_RASTERIZER;
 if(!renderer||!rasterizer)return {status:'unavailable',sourceSha256,code:'OFFICE_PREVIEW_NOT_CONFIGURED',note:'尚未配置可信Office预览程序；文件结构检查不等于逐页视觉核验。'};
 if(!path.isAbsolute(renderer)||!path.isAbsolute(rasterizer))return {status:'unavailable',sourceSha256,code:'OFFICE_PREVIEW_CONFIGURATION'};
 const run=options.run??promisify(execFile);let dir,phase='prepare';
 try{
  if((await lstat(directory)).isSymbolicLink())throw Error('linked');
  dir=await mkdtemp(path.join(directory,'office-preview-'));const source=path.join(dir,'source.'+format),pdf=path.join(dir,'source.pdf');await writeFile(source,bytes,{mode:0o600,flag:'wx'});
  const env={...process.env};
  if(process.platform==='darwin'){
   const config=path.join(dir,'fonts.conf');await writeFile(config,'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/System/Library/Fonts</dir><dir>/System/Library/Fonts/Supplemental</dir><dir>/Library/Fonts</dir><cachedir>'+xml(path.join(dir,'font-cache'))+'</cachedir><alias><family>Microsoft YaHei</family><prefer><family>Heiti SC</family></prefer></alias><alias><family>Microsoft YaHei Bold</family><prefer><family>Heiti SC</family></prefer></alias><alias><family>sans-serif</family><prefer><family>Heiti SC</family><family>Arial</family></prefer></alias></fontconfig>',{mode:0o600});env.FONTCONFIG_FILE=config;
  }
  phase='office_conversion';await run(renderer,['-env:UserInstallation='+pathToFileURL(path.join(dir,'profile')).href,'--headless','--convert-to','pdf','--outdir',dir,source],{env,cwd:dir,timeout:180000,maxBuffer:1048576});
  const pdfBytes=await readFile(pdf);if(pdfBytes.subarray(0,5).toString()!=='%PDF-')throw Error('invalid pdf');
  phase='page_rasterization';await run(rasterizer,['-scale-to','1500','-png',pdf,path.join(dir,'page')],{env,cwd:dir,timeout:180000,maxBuffer:1048576});
  const names=(await readdir(dir)).filter(n=>/^page-\d+\.png$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])),pages=[];if(!names.length)throw Error('missing pages');
  for(const name of names){const file=path.join(dir,name),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('invalid page');const b=await readFile(file);if(b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('invalid png');pages.push({path:file,sha256:hash(b),bytes:b.length});}
  await rm(source);await rm(path.join(dir,'profile'),{recursive:true,force:true});
  return {status:'rendered',sourceSha256,pageCount:pages.length,pdf:{path:pdf,sha256:hash(pdfBytes),bytes:pdfBytes.length},pages,note:'实际同一文件逐页渲染，仍需查看所有图片判断遮挡/溢出/字体。预览使用本机字体替代，不等于Office客户端动画验收；原文件未改。'};
 }catch{if(dir)await rm(dir,{recursive:true,force:true});return {status:'failed',sourceSha256,phase,code:'OFFICE_PREVIEW_FAILED',note:'Office预览失败，原文档保留；不能把结构成功等同视觉核验。请维护者核对本机渲染器。'};}
}

// A failed/missing preview may recover after configuration or renderer repair.
// Keep the document verification receipt immutable; cache the derived preview
// separately, bound to the unchanged actual file digest and owning directory.
export async function officePreviewEvidence(bytes,format,directory,fileId,recorded,options={}){
 if(!['pptx','docx'].includes(format))return recorded??null;
 if(!/^report-[a-f0-9-]{36}$/.test(fileId))throw Error('Invalid Office preview file binding');
 const {realpath,rename}=await import('node:fs/promises'),{randomUUID}=await import('node:crypto'),root=await realpath(directory),sourceSha256=hash(bytes),file=path.join(root,fileId+'.preview.json');
 async function valid(p){
  if(p?.status!=='rendered'||p.sourceSha256!==sourceSha256||!p.pages?.length||p.pageCount!==p.pages.length)return false;
  try{for(const v of [p.pdf,...p.pages]){const resolved=await realpath(v.path),s=await lstat(v.path);if(!resolved.startsWith(root+path.sep)||s.isSymbolicLink()||!s.isFile()||s.nlink!==1||hash(await readFile(v.path))!==v.sha256)return false;}return true;}catch{return false;}
 }
 if(await valid(recorded))return recorded;
 try{const s=await lstat(file);if(s.isSymbolicLink()||!s.isFile())throw Error('Linked preview receipt');const cached=JSON.parse(await readFile(file,'utf8'));if(cached.fileId===fileId&&await valid(cached.preview))return cached.preview;}catch(e){if(e.message==='Linked preview receipt')throw e;}
 const preview=await officePreview(bytes,format,root,options);
 if(preview.status==='rendered'){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify({fileId,sourceSha256,preview}),{mode:0o600,flag:'wx'});await rename(temp,file);}
 return preview;
}
