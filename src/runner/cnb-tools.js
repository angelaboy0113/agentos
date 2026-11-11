import {createHash} from 'node:crypto';
import {validateCnb,validateCnbQuery} from '../shared/cnb-policy.js';
import {cleanWebsiteText} from '../shared/website-policy.js';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const keys=['sn','slug','title','sha','sourceRef','targetRef','sourceSlug','event','status','createTime','duration','pipelineTotalCount','pipelineSuccessCount','pipelineFailCount'];
const filters=['createTime','endTime','event','sha','sn','sourceRef','targetRef','status','title'];
export async function createCnbTools(e,q,cred,adapters={}){
 validateCnb(e);validateCnbQuery(q);let active=true;
 const fetcher=adapters.cnbFetch??fetch;
 const check=async()=>{if(!active)throw fail('CNB_CLOSED','流水线只读工具已关闭');await adapters.authorize?.();};
 const repository=repo=>{if(!q.repositories.includes(repo))throw fail('CNB_SCOPE','仓库不在本次系统及环境的流水线只读范围');return repo;};
 const safe=value=>typeof value==='string'?cleanWebsiteText(value.split(cred.password).join('[已隐藏]'),2000):value;
 async function history(args){
  const repo=repository(args.repository),page=args.page??1,limit=args.limit??q.maxRows;
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>q.maxRows||!Number.isSafeInteger((page-1)*limit))throw fail('REPORT_INPUT','page须为正安全整数，limit须在当前页大小范围');
  const url=new URL(e.cnb.apiOrigin+'/'+repo.split('/').map(encodeURIComponent).join('/')+'/-/build/logs');
  url.searchParams.set('page',String(page));url.searchParams.set('page_size',String(limit));
  for(const key of filters){
   if(args[key]===undefined)continue;
   const v=args[key];if(typeof v!=='string'||!v.length||v.length>200||/[\x00-\x1f\x7f]/.test(v))throw fail('REPORT_INPUT','流水线筛选值须为有效非空文本');
   if(['createTime','endTime'].includes(key)&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v))throw fail('REPORT_INPUT','日期筛选须为实际有效YYYY-MM-DD');
   if(key==='sha'&&!/^[a-f0-9]{7,64}$/i.test(v)||key==='sn'&&!/^cnb-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(v)||key==='status'&&!['pending','success','error','cancel'].includes(v))throw fail('REPORT_INPUT','构建号、提交或状态筛选无效');
   url.searchParams.set(key,v);
  }
  if(args.createTime&&args.endTime&&args.createTime>args.endTime)throw fail('REPORT_INPUT','起始日期不能晚于结束日期');
  let response;
  for(let attempt=0;attempt<2;attempt++){
   await check();
   try{response=await fetcher(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(q.timeoutMs),headers:{Authorization:'Bearer '+cred.password,Accept:'application/vnd.cnb.api+json'}});}catch{throw fail('CNB_NETWORK','CNB流水线单次读取连接失败或超时；已有证据保留，未执行构建');}
   if(attempt===0&&[429,502,503,504].includes(response.status)){await response.body?.cancel();await(adapters.pause??(ms=>new Promise(r=>setTimeout(r,ms))))(1000);continue;}
   break;
  }
  if(response.status!==200){await response.body?.cancel();const status=response.status;
   throw fail(status===401?'CNB_AUTH_EXPIRED':status===403?'CNB_PERMISSION':status===429?'CNB_RATE_LIMIT':'CNB_HTTP',status===401?'CNB流水线令牌无效、已过期或已撤销；需维护者更新本机凭据，不是源码令牌或数据库故障':status===403?'CNB流水线读取被拒绝；核对repo-cnb-history:r和该仓库资源范围，不能据此认定仓库不存在':'CNB流水线读取未成功（HTTP '+status+'）；不跟随重定向、不返回旧缓存冒充当前结果');
  }
  // One response page is bounded; complete history uses nextPage, not a total-call cap.
  const chunks=[];let length=0;const reader=response.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8*1024*1024)throw fail('CNB_RESPONSE','CNB单页响应过大，请减小limit后继续；不是整项任务截止');chunks.push(value);}}finally{await reader.cancel();}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'),(_k,v,c)=>typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v)?c.source:v);}catch(error){if(error.code)throw error;throw fail('CNB_RESPONSE','CNB流水线响应不是可核验的JSON');}
  const offset=(page-1)*limit;
  if(!Array.isArray(result?.data)||result.data.length>limit||!Number.isSafeInteger(result.total)||result.total<0||result.data.length&&result.total<offset+result.data.length||!result.data.length&&offset<result.total)throw fail('CNB_PAGINATION','CNB分页缺失或总数不一致；不将缺页当作空结果');
  const rows=result.data.map(row=>{
   if(!row||row.slug!==repo||typeof row.sn!=='string'||!/^cnb-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(row.sn)||args.sn&&row.sn!==args.sn)throw fail('CNB_SCOPE','流水线返回了不一致的仓库或构建号');
   return Object.fromEntries(keys.filter(k=>row[k]!==undefined&&['string','number','boolean'].includes(typeof row[k])).map(k=>[k,safe(row[k])]));
  });
  return{repository:repo,rows,total:result.total,page,pageSize:limit,nextPage:offset+rows.length<result.total?page+1:null,complete:offset+rows.length>=result.total,fetchedAt:new Date().toISOString(),resultHash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),snapshot:'逐次读取，非事务快照',evidenceType:'build-history',note:'createTime是构建开始时间，success是流水线结果；不单独证明所有服务当前运行版本或实际上线完成时间。未读取原始日志、变量、脚本或凭据。'};
 }
 const spec=[{tool:'connection',args:{repository:'optional exact configured repository; default first configured repository'},description:'Verify the build-history read token by reading one history record. No browser login; no trigger or deployment.'},{tool:'build_repositories',args:{},description:'List configured repository scope only, not live discovery or proof of platform access.'},{tool:'build_history',args:{repository:'exact configured repository',page:'1 or nextPage',limit:'page size',...Object.fromEntries(filters.map(k=>[k,'optional exact official history filter']))},description:'Read current CNB build history and source/target branch, SHA, event, status and start time. Follow nextPage for full coverage. A successful pipeline is not proof of current runtime deployment; commits and build start times are not deployment completion times. No raw logs, secrets or writes.'}];
 return{spec,async run(tool,args={}){
  await check();const contract=spec.find(x=>x.tool===tool);if(!contract||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(contract.args,k)))throw fail('REPORT_INPUT','未知流水线工具或参数');
  if(tool==='build_repositories')return{rows:q.repositories.map(repository=>({repository})),source:'reviewed-configuration',metadataVerified:false,complete:true};
  if(typeof cred.password!=='string'||!cred.password.length||/[\r\n]/.test(cred.password))throw fail('CNB_AUTH_EXPIRED','缺少有效的本机流水线只读令牌');
  if(tool==='connection'){const result=await history({repository:args.repository??q.repositories[0],limit:1});return{connected:true,kind:'cnb',repository:result.repository,scopeVerified:true,fetchedAt:result.fetchedAt,readOnlyBy:'fixed-GET-build-history',accountReadOnlyVerified:false};}
  return history(args);
 },async close(){active=false;}};
}
