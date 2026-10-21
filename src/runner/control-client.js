import {randomUUID} from 'node:crypto';
import {CONTROL_PROTOCOL,criticalControl,controlDigest} from '../shared/control-receipts.js';
const pause=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted)return reject(signal.reason);const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);}signal?.addEventListener('abort',abort,{once:true});});
export async function controlPost(config,route,body,{signal,timeoutMs=10000,pollMs=500,fetcher=fetch,onRecovery}={}){
 const encoded=JSON.stringify(body);body=JSON.parse(encoded);
 const durable=criticalControl(route,body),id=randomUUID(),digest=controlDigest(route,body),headers={authorization:`Bearer ${config.runnerToken}`,'content-type':'application/json'};
 if(durable)headers['x-agentos-request-id']=id;
 const request=async(url,options)=>{const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;const response=await fetcher(config.serverUrl+url,{...options,signal:combined});const payload=await response.json();if(!response.ok)throw Object.assign(new Error(`${route} failed (${response.status}): ${payload.error??'control request failed'}`),{statusCode:response.status});return payload;};
 let recovering=false,lastFailure;
 const post=()=>request(route,{method:'POST',headers,body:encoded});
 try{return await post();}catch(error){if(signal?.aborted)throw signal.reason;if(error.statusCode&&error.statusCode<500)throw error;lastFailure=error;if(!durable)throw Object.assign(new Error('本机状态请求暂未响应'),{code:'LOCAL_CONTROL_TIMEOUT'});recovering=true;}
 if(recovering)onRecovery?.({requestId:id,phase:'checking_receipt'});
 for(;;){
  signal?.throwIfAborted();
  try{
   const status=await request('/api/v1/control-requests/'+id,{method:'GET',headers:{authorization:headers.authorization,'x-agentos-runner':body.runnerId,'x-agentos-request-digest':digest}});
   if(status.protocol!==CONTROL_PROTOCOL)throw Object.assign(new Error('控制端不支持持久回执；未重复提交未知请求'),{statusCode:502,code:'LOCAL_CONTROL_UNCERTAIN'});
   if(status.state==='committed')return status.response;
   if(status.state==='unknown'){
    if(lastFailure?.statusCode)throw lastFailure;
    // The server confirmed no commit. The same immutable ID is transactionally deduplicated.
    try{return await post();}catch(error){if(error.statusCode&&error.statusCode<500)throw error;lastFailure=error;}
   }else if(status.state!=='pending')throw Object.assign(new Error('控制请求回执状态无效'),{statusCode:502});
  }catch(error){if(signal?.aborted)throw signal.reason;if(error.statusCode)throw error;}
  await pause(pollMs,signal); // No overall elapsed-time or retry-count cutoff.
 }
}
