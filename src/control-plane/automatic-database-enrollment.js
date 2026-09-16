import { readFile,writeFile,mkdir,rename,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { environmentFile,loadEnvironments,fingerprint,isEnvironmentOwner } from '../shared/environment-access.js';
import { CONNECTION_SQL } from '../shared/database-account-policy.js';
import { credential,boundedFetch,mysqlRead } from '../runner/environment-connector.js';
import { databaseCredential } from '../runner/config-endpoints.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function saveCredential(ref,value) {
 const helper=fileURLToPath(new URL('../../scripts/keychain-credential.py',import.meta.url));
 await new Promise((resolve,reject)=>{
  const p=spawn('/usr/bin/python3',[helper,'set-json',ref],{stdio:['pipe','ignore','ignore']});
  const timer=setTimeout(()=>{p.kill();reject(new Error('本机凭据保存超时'));},10000);
  p.once('error',()=>{clearTimeout(timer);reject(new Error('本机凭据不可保存'));});
  p.once('exit',code=>{clearTimeout(timer);code?reject(new Error('本机凭据不可保存')):resolve();});
  p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(value));
 });
}
export async function automaticDatabaseEnrollment(context, enrollment, adapters={}) {
 const file=adapters.file??environmentFile();const original=await readFile(file);const config=await loadEnvironments(file);
 const source=enrollment.databaseSource, e=config.environments[source?.sourceEnvironmentId];
 const q=e?.queries?.[source?.sourceQueryId], x=source?.connectionSource;
 const expired=()=>!Number.isFinite(Date.parse(enrollment.createdAt))||Date.now()-Date.parse(enrollment.createdAt)>1800000;
 if(expired() || enrollment.status!=='opening' || !e || e.kind!=='nacos' || e.projectId!==enrollment.projectId || e.tier!==enrollment.tier
  || fingerprint(e)!==source.sourceConfigHash || !isEnvironmentOwner(e,enrollment.approver)
  || q?.mode!=='investigate' || !x || !q.namespaces.includes(x.namespace))throw new Error('接入授权或来源范围已变更，请重新申请');
 const url=new URL(enrollment.url);
 if(url.protocol!=='mysql:'||url.username||url.password||url.search||url.hash||url.hostname!==source.host||Number(url.port||3306)!==source.port||url.pathname!=='/'+source.database)throw new Error('目标地址与已确认配置不一致');
 const request=adapters.fetch??boundedFetch, loginCred=await (adapters.credential??credential)(e.credentialRef);
 const login=JSON.parse(await request(e.baseUrl+'/v1/auth/login',{method:'POST',signal:AbortSignal.timeout(q.timeoutMs),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(loginCred)},16000));
 if(typeof login.accessToken!=='string'||!login.accessToken)throw new Error('环境认证未成功');
 const sourceUrl=new URL(e.baseUrl+'/v1/cs/configs');sourceUrl.search=new URLSearchParams({tenant:x.namespace,group:x.group,dataId:x.dataId,accessToken:login.accessToken}).toString();
 const content=await request(sourceUrl,{signal:AbortSignal.timeout(q.timeoutMs)});
 if(sha(content)!==x.contentHash)throw new Error('Nacos配置已改变，请重新发现并确认');
 const dbCred=databaseCredential(content,source); // local only; never model/state/event data
 const id=enrollment.id.toLowerCase();
 const target={kind:'mysql',projectId:e.projectId,tier:e.tier,host:source.host,port:source.port,database:source.database,tls:true,credentialRef:id,
  ownerOpenIdsByProfile:e.ownerOpenIdsByProfile,membersRead:e.membersRead,accountPolicy:'business-readonly',
  businessAccountAuthorization:{approverId:enrollment.approver.senderId,confirmedAt:new Date().toISOString()},queries:{
   connection_check:{reviewed:true,description:'测试数据库连接与只读事务',sql:CONNECTION_SQL,parameters:[],outputColumns:['database_name','checked_at'],maxRows:1,timeoutMs:5000},
   investigate:{reviewed:true,mode:'investigate',description:'在已确认数据库基础表中受控读取；业务账号使用只读事务',tables:['*'],parameters:[{name:'purpose',type:'string',maxLength:200}],maxRows:20,maxCalls:8,timeoutMs:5000}}};
 await (adapters.mysqlRead??mysqlRead)(target,target.queries.connection_check,[],dbCred);
 if(expired() || !(await readFile(file)).equals(original))throw new Error('配置或申请已变更，请重新确认');
 if(config.environments[id])throw new Error('入口已存在，不重复接入');
 const dir=path.join(context.config.dataDir,'environment-enrollments',enrollment.id);await mkdir(dir,{recursive:true,mode:0o700});
 const temp=file+'.'+enrollment.id+'.tmp';
 try {
  config.environments[id]=target;await writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});await loadEnvironments(temp);
  await (adapters.saveCredential??saveCredential)(id,dbCred);
  if(expired() || !(await readFile(file)).equals(original))throw new Error('配置或申请已变更，请重新确认');
  const backup=path.join(context.config.dataDir,'environment-config-backups',enrollment.id);await mkdir(backup,{recursive:true,mode:0o700});
  await writeFile(path.join(backup,'environments.local.json'),original,{mode:0o400});await writeFile(path.join(backup,'manifest.json'),JSON.stringify({sha256:sha(original),bytes:original.length}),{mode:0o400});
  await rename(temp,file);
  const status=path.join(dir,'status.json');await writeFile(status+'.tmp',JSON.stringify({status:'complete'}),{mode:0o600});await rename(status+'.tmp',status);
 } finally {await rm(temp,{force:true});}
}
