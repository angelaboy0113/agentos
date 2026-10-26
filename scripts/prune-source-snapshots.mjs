// Read-only inventory defaults to local state. Live deletion MUST go through the
// control-plane writer, which rechecks references atomically before removal.
import {readFile} from 'node:fs/promises';
import {pruneSourceSnapshots} from '../src/shared/source-snapshot-gc.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
if(args.includes('--apply')){
 if(!args.includes('--server')||!process.env.AGENTOS_ADMIN_TOKEN)throw new Error('Apply requires --server and AGENTOS_ADMIN_TOKEN; do not delete against a live state-file copy.');
 const url=new URL(value('--server'));if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('Maintenance API must be local');
 const r=await fetch(new URL('/api/v1/admin/source-snapshots/prune',url),{method:'POST',headers:{authorization:'Bearer '+process.env.AGENTOS_ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({apply:true})});if(!r.ok)throw new Error('Maintenance request failed '+r.status);console.log(JSON.stringify(await r.json()));
}else{
 if(!args.includes('--projects')||!args.includes('--state'))throw new Error('Usage: --projects <projects.json> --state <agentos.json> (preview); --apply --server <local URL> (authenticated live cleanup)');
 const projects=JSON.parse(await readFile(value('--projects'),'utf8')).projects;
 for(const [id,p]of Object.entries(projects))console.log(JSON.stringify({project:id,...await pruneSourceSnapshots({...p,id},{getState:async()=>JSON.parse(await readFile(value('--state'),'utf8')),onProgress:async p=>{if(p.checked%25===0)process.stderr.write(JSON.stringify({checked:p.checked,total:p.total})+'\n');}})}));
}
