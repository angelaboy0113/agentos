import {getHeapStatistics} from 'node:v8';
import os from 'node:os';
import {execFile} from 'node:child_process';

// Admission only: never abort a running task, revoke a lease, or replay work.
export class MemoryAdmission {
 constructor({sample,treeSample=processTreeRss,treeBudgetMiB=Math.floor(os.totalmem()/1048576/2),now=Date.now}={}){
  if(!Number.isSafeInteger(treeBudgetMiB)||treeBudgetMiB<256)throw Error('memoryAdmissionMiB must be an integer >=256');
  this.now=now;this.treeSample=treeSample;this.treeBudgetBytes=treeBudgetMiB*1048576;
  this.sample=sample??(()=>({...process.memoryUsage(),heapLimit:getHeapStatistics().heap_size_limit}));
  this.paused=false;this.transitions=0;this.peakHeapBytes=0;this.peakRssBytes=0;this.treeRssBytes=0;
 }
 check(){
  const m=this.sample(),ratio=m.heapUsed/m.heapLimit;
  this.peakHeapBytes=Math.max(this.peakHeapBytes,m.heapUsed);this.peakRssBytes=Math.max(this.peakRssBytes,m.rss);
  const heapHigh=ratio>=0.75,treeHigh=this.treeRssBytes>=this.treeBudgetBytes;
  const next=heapHigh||treeHigh||this.paused&&(ratio>0.60||this.treeRssBytes>this.treeBudgetBytes*0.8);
  if(next!==this.paused){this.transitions++;this.changedAt=new Date(this.now()).toISOString();}
  this.paused=next;
  return {policy:'memory-admission-v1',allowed:!next,reason:next?'memory_pressure':null,heapUsedBytes:m.heapUsed,heapLimitBytes:m.heapLimit,rssBytes:m.rss,treeRssBytes:this.treeRssBytes,treeBudgetBytes:this.treeBudgetBytes,treeSampleAt:this.treeSampleAt??null,treeSampleUnavailable:this.treeSampleUnavailable??false,peakHeapBytes:this.peakHeapBytes,peakRssBytes:this.peakRssBytes,transitions:this.transitions};
 }
 async refresh(){if(this.refreshing)return this.refreshing;this.refreshing=(async()=>{try{this.treeRssBytes=await this.treeSample();this.treeSampleAt=new Date(this.now()).toISOString();this.treeSampleUnavailable=false;}catch{this.treeSampleUnavailable=true;}finally{this.check();}})();try{return await this.refreshing;}finally{this.refreshing=null;}}
 start(){void this.refresh();this.timer=setInterval(()=>void this.refresh(),2000);this.timer.unref();}
 stop(){clearInterval(this.timer);}
}
// RSS sums are conservative (shared pages may be counted twice). Arguments and
// credentials are never read; only PID, parent PID and resident KB are requested.
export function processTreeRss(root=process.pid){return new Promise((resolve,reject)=>{
 if(!['darwin','linux'].includes(process.platform))return reject(Error('Tree RSS unavailable on this platform'));
 execFile('ps',['-axo','pid=,ppid=,rss='],{timeout:1500,maxBuffer:4*1024*1024},(error,out)=>{
  if(error)return reject(error);const rows=out.trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number)).filter(r=>r.length===3&&r.every(Number.isFinite));
  const ids=new Set([root]);let size;do{size=ids.size;for(const[p,pp]of rows)if(ids.has(pp))ids.add(p);}while(size!==ids.size);
  resolve(rows.reduce((n,[p,,rss])=>n+(ids.has(p)?rss*1024:0),0));
 });
});}
