import {validateSshTransport} from '../shared/ssh-transport-policy.js';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {credential} from './environment-connector.js';
const require=createRequire(import.meta.url);
const script=fileURLToPath(new URL('../../scripts/ssh-askpass.py',import.meta.url));
const worker=fileURLToPath(new URL('./ssh-mysql-worker.cjs',import.meta.url));
let archivePromise;
async function archive(){
 if(!archivePromise)archivePromise=(async()=>{
  const found=new Map();async function add(name,req){if(found.has(name))return;let dir=path.dirname(req.resolve(name==='mysql2'?'mysql2/promise':name));while(path.dirname(dir)!==dir){try{const p=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));if(p.name===name){found.set(name,dir);const next=createRequire(path.join(dir,'package.json'));for(const dep of Object.keys(p.dependencies??{}))await add(dep,next);return;}}catch(e){if(e.code!=='ENOENT')throw e;}dir=path.dirname(dir);}throw new Error('Remote driver dependency unavailable');}
  await add('mysql2',require);
  const child=spawn('python3',[fileURLToPath(new URL('../../scripts/package-remote-mysql.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});const chunks=[];let bytes=0;
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.stdout.on('data',b=>{bytes+=b.length;if(bytes>16000000){child.kill();reject(new Error('Remote driver package too large'));}else chunks.push(b);});child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error('Remote driver packaging failed')));});
  child.stderr.resume();child.stdin.end(JSON.stringify({packages:[...found].map(([name,p])=>({name,path:p})),worker}));return done;
 })().catch(e=>{archivePromise=null;throw e;});return archivePromise;
}
// Read exactly the archive bytes, leaving the following stdin JSON lines for Node.
const loader=`import os,sys,tempfile,tarfile,io,subprocess,shutil,signal\ndef stop(*args): raise SystemExit(1)\nsignal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)\nline=b''\nwhile not line.endswith(b'\\n'): line+=os.read(0,1)\nn=int(line);assert 0<n<=16000000\nb=b''\nwhile len(b)<n:\n c=os.read(0,min(n-len(b),65536))\n if not c: raise RuntimeError('Incomplete application archive')\n b+=c\nd=tempfile.mkdtemp(prefix='agentos-mysql-',dir='/tmp')\ntry:\n with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:\n  assert all(not m.name.startswith('/') and '..' not in m.name.split('/') and not m.issym() and not m.islnk() for m in t.getmembers())\n  t.extractall(d)\n p=subprocess.Popen(['node',d+'/worker.cjs']);sys.exit(p.wait())\nfinally:\n if 'p' in locals() and p.poll() is None: p.terminate()\n shutil.rmtree(d,ignore_errors=True)`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export async function sshRemoteConnection(e,q,cred,adapters={}){
 validateSshTransport(e.transport);const t=e.transport;
 const jump=await (adapters.credential??credential)(t.credentialRef);
 if(!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(jump.username))throw new Error('SSH账号无效');
 await readFile(t.knownHostsFile);
 const packed=await (adapters.archive??archive)();
 const args=['-F','/dev/null','-T','-p',String(t.port),'-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+t.knownHostsFile,'-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-o','ForwardX11=no','-o','ControlMaster=no','-o','ControlPath=none','-o','ConnectTimeout=15','-o','NumberOfPasswordPrompts=1','-o','PreferredAuthentications=password,keyboard-interactive','-o','PubkeyAuthentication=no',jump.username+'@'+t.host,'python3 -c '+quote(loader)];
 const child=(adapters.spawn??spawn)('/usr/bin/ssh',args,{stdio:['pipe','pipe','pipe'],env:{...process.env,SSH_ASKPASS:script,SSH_ASKPASS_REQUIRE:'force',DISPLAY:'agentos:0',AGENTOS_SSH_CREDENTIAL_REF:t.credentialRef}});
 let next=0,buffer='',closed=false;const pending=new Map();
 function fail(code){const error=Object.assign(new Error('SSH远程数据库执行失败；未回退本地连接'),{code});for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();}
 child.on('error',()=>{closed=true;fail('SSH_EXECUTION_FAILED');});child.on('close',()=>{closed=true;fail('SSH_EXECUTION_CLOSED');});child.stdin.on('error',()=>fail('SSH_STDIN_CLOSED'));child.stderr.resume();
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>32000000){destroy();fail('SSH_RESPONSE_TOO_LARGE');return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let r;try{r=JSON.parse(line);}catch{destroy();fail('SSH_PROTOCOL');return;}const p=pending.get(r.id);if(!p)continue;pending.delete(r.id);clearTimeout(p.timer);r.ok?p.resolve([r.rows]):p.reject(Object.assign(new Error('远程MySQL请求失败'),{code:r.code,errno:r.errno,sqlState:r.sqlState,...(Number.isInteger(r.serverWireVersion)?{serverWireVersion:r.serverWireVersion}:{}),...(Number.isInteger(r.minimumWireVersion)?{minimumWireVersion:r.minimumWireVersion}:{})}));}});
 function destroy(){if(closed)return;closed=true;child.stdin.end();child.kill('SIGTERM');fail('SSH_EXECUTION_CLOSED');}
 function request(payload,timeout=q.timeoutMs){if(closed)return Promise.reject(new Error('SSH连接已结束'));const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('远程数据库请求超时'),{code:'ETIMEDOUT'}));destroy();},timeout);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,...payload})+'\n');});}
 child.stdin.write(String(packed.length)+'\n');child.stdin.write(packed);
 try{await request({connection:adapters.connectionPayload??{host:e.host,port:e.port,database:e.database,user:cred.username,password:cred.password,connectTimeout:q.timeoutMs,...(e.tls?{ssl:{rejectUnauthorized:true}}:{})}},q.timeoutMs+15000);}catch(error){destroy();throw error;}
 const call=(method,statement,params=[])=>request({method,sql:typeof statement==='string'?statement:statement.sql,params,timeout:typeof statement==='object'?statement.timeout??q.timeoutMs:q.timeoutMs},typeof statement==='object'?statement.timeout??q.timeoutMs:q.timeoutMs);
 return {query:(s,p)=>call('query',s,p),execute:(s,p)=>call('execute',s,p),rollback:()=>call('query','ROLLBACK'),request,destroy};
}
export const sshMysqlConnection=(...args)=>sshRemoteConnection(...args);
