// Read-only inventory defaults to local state. Live deletion MUST go through the
// control-plane writer, which rechecks references atomically before removal.
import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {pruneSourceSnapshots} from '../src/shared/source-snapshot-gc.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
if(args.includes('--apply')){
 if(!args.includes('--server'))throw new Error('Apply requires --server; do not delete against a live state-file copy.');
 const url=new URL(value('--server'));if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('Maintenance API must be local');
 const headers={'content-type':'application/json'};{const session=await fetch(new URL('/admin',url));if(!session.ok)throw new Error('Local console session unavailable');const cookie=session.headers.get('set-cookie')?.split(';')[0];await session.arrayBuffer();if(!cookie)throw new Error('Local console did not establish a session');headers.cookie=cookie;headers.origin=url.origin;headers['x-agentos-admin']='1';}
 // A verified large-tree sweep may take longer than fetch's implicit header wait.
 // The local request has no whole-operation timeout; interruption does not rerun it.
 const endpoint=new URL('/api/v1/admin/source-snapshots/prune',url),request=endpoint.protocol==='https:'?httpsRequest:httpRequest;
 const data=await new Promise((resolve,reject)=>{const req=request(endpoint,{method:'POST',headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Maintenance request failed '+res.statusCode);resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);}});});req.on('error',reject);req.end(JSON.stringify({apply:true}));});console.log(JSON.stringify(data));
}else{
 if(!args.includes('--projects')||!args.includes('--state'))throw new Error('Usage: --projects <projects.json> --state <agentos.json> (preview); --apply --server <local URL> (authenticated live cleanup)');
 const projects=JSON.parse(await readFile(value('--projects'),'utf8')).projects;
 for(const [id,p]of Object.entries(projects))console.log(JSON.stringify({project:id,...await pruneSourceSnapshots({...p,id},{getState:async()=>JSON.parse(await readFile(value('--state'),'utf8')),onProgress:async p=>{if(p.checked%25===0)process.stderr.write(JSON.stringify({checked:p.checked,total:p.total})+'\n');}})}));
}
