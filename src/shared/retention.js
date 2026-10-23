// Retention is opt-in per deployment; no process other than the state owner writes state.
import path from 'node:path';
import {lstat,readdir,readFile,rm} from 'node:fs/promises';
const DAY=86400000;
const terminalJobs=new Set(['completed','failed','cancelled','blocked']);
const activeTurns=new Set(['queued','thinking','decided','ready']);
const closedEnrollments=new Set(['complete','failed','cancelled','superseded','expired']);
const date=v=>typeof v==='number'?v:Date.parse(v);
export const recordTime=v=>Math.max(...['createdAt','updatedAt','completedAt','deliveredAt','supersededAt','at','lastSeenAt'].map(k=>date(v?.[k])).filter(Number.isFinite),-Infinity);
const old=(v,cutoff)=>Number.isFinite(recordTime(v))&&recordTime(v)<cutoff;
const values=v=>Object.values(v??{});
const visit=(v,fn)=>{if(typeof v==='string')fn(v);else if(v&&typeof v==='object')for(const x of Object.values(v))visit(x,fn);};
export function retentionPolicy(days=0){
 if(!Number.isInteger(days)||days<0||days>3650)throw new Error('Invalid retentionDays');
 return {enabled:days>0,days,intervalMs:DAY};
}
export function pruneHistory(state,cutoff,{busyJobs=new Set(),busyCards=new Set()}={}){
 // Connected records are retained together: stages, supplements, enrollments and cross-job evidence.
 const nodes=[...(state.jobs??[]),...(state.conversations??[]),...values(state.questions),...values(state.environmentEnrollments)];
 const parent=new Map(nodes.map(x=>[x.id,x.id]));
 const root=id=>{let p=parent.get(id);while(p!==parent.get(p))p=parent.get(p);return p;};
 const join=(a,b)=>{if(parent.has(a)&&parent.has(b))parent.set(root(a),root(b));};
 for(const x of nodes){
  join(x.id,x.questionId);join(x.id,x.rootTurnId);join(x.id,x.latestTurnId);join(x.id,x.turnId);
  // Parent question is a historical navigation link, not a requirement to keep every old topic forever.
  for(const [key,value] of Object.entries(x))if(!['parentQuestionId','parentId','questionId','rootTurnId','latestTurnId','turnId'].includes(key))visit(value,id=>join(x.id,id));
 }
 const retained=new Set();
 const keep=id=>{if(parent.has(id))retained.add(root(id));};
 for(const x of nodes)if(!old(x,cutoff))keep(x.id);
 for(const j of state.jobs??[])if(!terminalJobs.has(j.status)||busyJobs.has(j.id))keep(j.id);
 for(const t of state.conversations??[])if(activeTurns.has(t.status)||t.setupPending)keep(t.id);
 for(const e of values(state.environmentEnrollments))if(!closedEnrollments.has(e.status))keep(e.id);
 for(const [key,c] of Object.entries(state.cardMessages??{}))if(busyCards.has(key)||c.revision!==c.deliveredRevision||(c.terminalMention&&!c.mentionDelivered)||c.retiredMessageIds?.length){
  keep(key.split(':')[1]);
 }
 for(const e of values(state.reportDeliveries))if(!e.messageId&&!e.superseded) {keep(e.sourceJobId);keep(e.questionId);}
 const removed=new Set(nodes.filter(x=>!retained.has(root(x.id))).map(x=>x.id));
 const counts={};
 for(const key of ['jobs','conversations'])if(state[key]){const n=state[key].length;state[key]=state[key].filter(x=>!removed.has(x.id));counts[key]=n-state[key].length;}
 for(const key of ['questions','environmentEnrollments'])for(const [id] of Object.entries(state[key]??{}))if(removed.has(id)){delete state[key][id];counts[key]=(counts[key]??0)+1;}
 const hasRemoved=v=>{let yes=false;visit(v,id=>{if(removed.has(id))yes=true;});return yes;};
 const keptJobs=new Set((state.jobs??[]).map(x=>x.id));
 const keptTurns=new Set((state.conversations??[]).map(x=>x.id));
 for(const [key,value] of Object.entries(state.processedMessages??{}))if(!keptJobs.has(value)&&!keptTurns.has(value))delete state.processedMessages[key];
 for(const [key,value] of Object.entries(state.cardMessages??{}))if(removed.has(key.split(':')[1])){delete state.cardMessages[key];counts.cards=(counts.cards??0)+1;}
 for(const [key,value] of Object.entries(state.reportDeliveries??{}))if(removed.has(value.sourceJobId)||removed.has(value.questionId))delete state.reportDeliveries[key];
 for(const [key,value] of Object.entries(state.effects??{}))if(hasRemoved(value)||[...removed].some(id=>key.includes(id))||old(value,cutoff))delete state.effects[key];
 for(const [key,value] of Object.entries(state.controlReceipts??{}))if(old(value,cutoff)&&!keptJobs.has(value.jobId))delete state.controlReceipts[key];
 for(const key of ['adminAudit','cardCallbackAudit','cardActionPresentationFailures'])if(state[key])state[key]=state[key].filter(x=>!old(x,cutoff));
 for(const [key,value] of Object.entries(state.runners??{}))if(old(value,cutoff)&&!(state.jobs??[]).some(j=>j.lease?.runnerId===key))delete state.runners[key];
 // Navigation to expired questions must not imply that their content can still be retrieved.
 for(const q of values(state.questions))if(removed.has(q.parentQuestionId))delete q.parentQuestionId;
 const keptIds=new Set([...keptJobs,...keptTurns,...Object.keys(state.questions??{}),...Object.keys(state.environmentEnrollments??{}),...(state.conversations??[]).map(t=>t.messageId).filter(Boolean)]);
 const paths=new Set();visit(state,v=>{if(path.isAbsolute(v))paths.add(path.resolve(v));});
 return {counts,removed,keptIds,paths};
}
const within=(root,p)=>p===root||p.startsWith(root+path.sep);
// Reject symlinks in every existing ancestor, not merely the leaf.
export async function realDirectory(directory){
 const resolved=path.resolve(directory);let current=path.parse(resolved).root;
 for(const part of resolved.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())return false;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 return true;
}
async function treeTime(file){
 const s=await lstat(file);if(s.isSymbolicLink())return Infinity;
 if(s.isFile())return s.mtimeMs;
 if(!s.isDirectory())return Infinity;
 let latest=s.mtimeMs;
 for(const name of await readdir(file)){
  // Never recursively delete a Git worktree with user changes or shared Git metadata.
  if(name==='.git'&&(await lstat(path.join(file,name))).isFile())return Infinity;
  latest=Math.max(latest,await treeTime(path.join(file,name)));
 }
 return latest;
}
export async function sweepArtifacts({root,cutoff,paths=new Set(),keptIds=new Set(),pattern,manifest=false,depth=1}){
 if(!await realDirectory(root))return 0;
 let removed=0;
 for(const name of await readdir(root)){
  const full=path.join(root,name),s=await lstat(full);
  if(s.isSymbolicLink()||pattern&&!pattern.test(name))continue;
  if(depth>1&&s.isDirectory()){removed+=await sweepArtifacts({root:full,cutoff,paths,keptIds,depth:depth-1});continue;}
  if([...paths].some(p=>within(full,p)||within(p,full))||[...keptIds].some(id=>name.includes(id)))continue;
  if(manifest){try{const m=JSON.parse(await readFile(path.join(full,'source-manifest.json'),'utf8'));if(m.policy!=='isolated-environment-source-v1'||path.resolve(m.workspace)!==path.join(full,'workspace'))continue;}catch{continue;}}
  if(s.mtimeMs>=cutoff||await treeTime(full)>=cutoff)continue;
  await rm(full,{recursive:true,force:true});removed++;
 }
 return removed;
}
