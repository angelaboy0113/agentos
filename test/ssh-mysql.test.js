import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';import os from 'node:os';
import {validateSshTransport} from '../src/shared/ssh-transport-policy.js';
import {sshMysqlConnection} from '../src/runner/ssh-mysql.js';
const transport={mode:'ssh-remote-execution',host:'jump.example',port:22,credentialRef:'ssh_ref',knownHostsFile:'/tmp/known_hosts'};
test('SSH transport accepts only remote execution and forbids configurable shell, tunnels and credential values',()=>{
 validateSshTransport(transport);
 for(const change of [{mode:'tunnel'},{localPort:3306},{password:'secret'},{command:'anything'},{host:'jump;bad'},{knownHostsFile:'relative'}])assert.throws(()=>validateSshTransport({...transport,...change}));
});
test('remote connection protocol keeps credentials out of argv/env and preserves exact decimal values without local fallback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ssh-mysql-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const hosts=path.join(dir,'hosts');await writeFile(hosts,'pinned-host');
 let observed,requests=[],buffer=Buffer.alloc(0),packLength=null;
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',0));};
 child.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(packLength===null){const end=buffer.indexOf(10);if(end<0)return;packLength=Number(buffer.subarray(0,end));buffer=buffer.subarray(end+1);}if(packLength>0){if(buffer.length<packLength)return;buffer=buffer.subarray(packLength);packLength=0;}let end;while((end=buffer.indexOf(10))>=0){const r=JSON.parse(buffer.subarray(0,end));buffer=buffer.subarray(end+1);requests.push(r);queueMicrotask(()=>child.stdout.write(JSON.stringify({id:r.id,ok:true,rows:r.connection?undefined:[{amount:'12345678901234567890.01'}]})+'\n'));}});
 const c=await sshMysqlConnection({host:'db.example',port:3306,database:'business',transport:{...transport,knownHostsFile:hosts}},{timeoutMs:1000},{username:'business',password:'DB_SENTINEL'},{archive:async()=>Buffer.from('package'),credential:async()=>({username:'ubuntu',password:'SSH_SENTINEL'}),spawn:(cmd,args,options)=>{observed={cmd,args,options};return child;}});
 assert.equal((await c.execute({sql:'SELECT amount FROM business',timeout:1000},[]))[0][0].amount,'12345678901234567890.01');
 assert.doesNotMatch(JSON.stringify(observed),/DB_SENTINEL|SSH_SENTINEL/);assert.ok(observed.args.includes('ClearAllForwardings=yes'));assert.ok(observed.args.includes('StrictHostKeyChecking=yes'));assert.ok(observed.args.includes('/dev/null'));assert.ok(!observed.args.some(a=>/^-[LRD]$/.test(a)));
 assert.equal(requests[0].connection.password,'DB_SENTINEL');assert.equal(requests[1].method,'execute');await c.rollback();c.destroy();await assert.rejects(c.query('SELECT 1'),/结束/);
});
test('remote worker rejects writes, stored procedures and SQL file access even when the database account has EXECUTE',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ssh-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const hook=path.join(dir,'driver.cjs');await writeFile(hook,`const Module=require('module'),load=Module._load;Module._load=function(name,...args){return name==='mysql2/promise'?{createConnection:async()=>({query:async()=>[[{safe:true}]],execute:async()=>[[{amount:'0.10'}]],rollback:async()=>{},destroy:()=>{}})}:load.call(this,name,...args)};`);
 const child=spawn(process.execPath,['--require',hook,path.resolve('src/runner/ssh-mysql-worker.cjs')],{stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.resume();
 const sqls=['START TRANSACTION READ ONLY','SELECT amount FROM orders WHERE id=?','UPDATE orders SET amount=1','CALL change_order()','SELECT 1 INTO OUTFILE \'/tmp/x\'','START TRANSACTION','SELECT SLEEP(1)'];
 child.stdin.end([JSON.stringify({id:0,connection:{}}),...sqls.map((sql,i)=>JSON.stringify({id:i+1,method:'query',sql,params:[],timeout:1000}))].join('\n')+'\n');
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});const out=text.trim().split('\n').map(x=>JSON.parse(x));assert.equal(out.length,8);assert.ok(out.slice(0,3).every(x=>x.ok));assert.ok(out.slice(3).every(x=>!x.ok&&x.code==='REMOTE_READONLY_SQL'));
});

test('SSH authentication/host failure rejects controlled tools and never invokes the local MySQL driver',async t=>{
 const {createEnvironmentTools}=await import('../src/runner/environment-tools.js');const dir=await mkdtemp(path.join(os.tmpdir(),'ssh-no-fallback-'));t.after(()=>rm(dir,{recursive:true,force:true}));const hosts=path.join(dir,'hosts');await writeFile(hosts,'pinned-host');let localConnections=0;
 const e={kind:'mysql',host:'db.test',port:3306,database:'sample',transport:{...transport,knownHostsFile:hosts}};
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const tools=await createEnvironmentTools(e,{mode:'investigate',tables:['*'],maxRows:20,timeoutMs:1000},{username:'reader',password:'hidden'},{mysql:{createConnection:async()=>{localConnections++;throw new Error('LOCAL_FALLBACK');}},archive:async()=>Buffer.from('test'),credential:async()=>({username:'ubuntu',password:'jump-hidden'}),spawn:()=>{setImmediate(()=>child.emit('close',255));return child;}});
 await assert.rejects(tools.run('connection',{}),/SSH/);assert.equal(localConnections,0);await tools.close();
});
