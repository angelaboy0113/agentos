// Reuse serialized records by immutable reference. Persistence remains one atomic,
// backward-compatible JSON file; no duplicate monolithic string during updates.
import {createWriteStream} from'node:fs';import{Readable}from'node:stream';import{pipeline}from'node:stream/promises';
const json=v=>JSON.stringify(v),object=v=>v!==null&&typeof v==='object';
export function encodeState(state,previous){
 let encodedRecords=0;const root=new Map(),segments=['{'];
 function unit(value,prior){
  if(prior?.value===value)return prior;
  if(!object(value))return {value,segments:[json(value)]};
  const array=Array.isArray(value),keys=array?Array.from({length:value.length},(_,i)=>String(i)):Object.keys(value).filter(k=>value[k]!==undefined),entries=new Map(),parts=[array?'[':'{'];
  // Only the top-level collections are divided into independently reused records.
  for(const [i,key]of keys.entries()){
   if(i)parts.push(',');if(!array)parts.push(json(key)+':');
   const v=value[key],old=prior?.entries?.get(key);let record;
   if(old?.value===v)record=old;else{record={value:v,text:json(v)??'null'};encodedRecords++;}
   entries.set(key,record);parts.push(record.text);
  }
  parts.push(array?']':'}');return {value,entries,segments:parts};
 }
 for(const key of Object.keys(state)){
  if(state[key]===undefined)continue;if(root.size)segments.push(',');segments.push(json(key)+':');const next=unit(state[key],previous?.root.get(key));root.set(key,next);for(const segment of next.segments)segments.push(segment);
 }
 segments.push('}\n');return {root,segments,encodedRecords};
}
export const sameEncoding=(a,b)=>Boolean(a&&a.segments.length===b.segments.length&&a.segments.every((s,i)=>s===b.segments[i]));
export async function writeEncoding(file,encoding){
 // Coalesce small index records but never concatenate the whole history.
 async function* chunks(){let pending='',bytes=0;for(const s of encoding.segments){const n=Buffer.byteLength(s);if(bytes+n>65536&&pending){yield pending;pending='';bytes=0;}if(n>65536){yield s;continue;}pending+=s;bytes+=n;}if(pending)yield pending;}
 await pipeline(Readable.from(chunks()),createWriteStream(file,{mode:0o600}));
}
