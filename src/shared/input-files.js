import path from 'node:path';
import {stat} from 'node:fs/promises';
import {hashFile} from './file-digest.js';
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xls':'application/vnd.ms-excel','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.doc':'application/msword','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.csv':'text/csv','.tsv':'text/tab-separated-values','.txt':'text/plain','.md':'text/markdown','.json':'application/json','.log':'text/plain','.zip':'application/zip'};
export const inputFileName=value=>path.basename(String(value??'').replaceAll('\\','/')).replace(/[\x00-\x1f]/g,'_');
export function inputFileExtension(a){const ext=path.extname(inputFileName(a.name??a.path??'')).toLowerCase();if(/^\.[a-z0-9]+$/.test(ext))return ext;return Object.keys(types).find(k=>types[k]===a.contentType)??'.bin';}
export async function inputFileMetadata(file,{id,name,type,sourceMessageId}={}){const info=await stat(file);const filename=inputFileName(name||file);return {id,name:filename,path:file,type:type??(/\.(png|jpe?g|gif|webp|bmp)$/i.test(filename)?'image':'file'),contentType:types[path.extname(filename).toLowerCase()]??'application/octet-stream',size:info.size,sha256:await hashFile(file),...(sourceMessageId?{sourceMessageId}:{})};}
// Resources, rather than arbitrary directory contents, define which files this message actually supplied.
export function messageResources(value){const out=[];function visit(v){if(!v||typeof v!=='object')return;if(Array.isArray(v)){for(const x of v)visit(x);return;}
 let body=v.body?.content??v.content;try{if(typeof body==='string')body=JSON.parse(body);}catch{}
 const name=v.file_name??body?.file_name??(typeof body==='string'?body.match(/<file\b[^>]*\bname="([^"]+)"/)?.[1]:undefined);
 if(Array.isArray(v.resources))for(const r of v.resources)out.push({...r,name:r.file_name??r.name??name,chatId:v.chat_id});
 for(const [key,x]of Object.entries(v))if(key!=='resources')visit(x);
 }visit(value);return out;}
