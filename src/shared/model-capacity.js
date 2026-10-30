// Retry only a definite model-capacity rejection, never uncertain transport or tool failures.
export function isModelCapacityError(error) {
 return /selected model is at capacity|model.{0,40}(?:at capacity|overloaded|temporarily unavailable)/i.test(String(error?.message??error??''));
}
export function capacityWait(ms,signal){return new Promise((resolve,reject)=>{
 let timer;const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new Error('Model capacity wait aborted'));};
 const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
 if(signal?.aborted)return abort();timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});
});}
export async function retryModelCapacity(run,{signal,onRetry=async()=>{},wait=capacityWait,active=()=>true,delayMs}={}){
 let attempt=0;
 for(;;){
  if(signal?.aborted||(attempt>0&&!active()))throw new Error('Model capacity wait aborted');
  try{return await run();}catch(error){
   if(!isModelCapacityError(error)||signal?.aborted||!active())throw error;
   attempt++;await onRetry({attempt,error});
   await wait(delayMs??Math.min(attempt*1000,10000),signal);
  }
 }
}
