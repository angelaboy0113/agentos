// Offline maintenance. Defaults to a plan; --apply deletes only validated,
// unused managed clones. Never changes question state or service registration.
import {readFile} from 'node:fs/promises';
import {pruneSourceSnapshots} from '../src/shared/source-snapshot-gc.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
if(!args.includes('--projects')||!args.includes('--state'))throw new Error('Usage: node scripts/prune-source-snapshots.mjs --projects <projects.json> --state <agentos.json> [--apply]');
const projects=JSON.parse(await readFile(value('--projects'),'utf8')).projects;
for(const [id,project]of Object.entries(projects)){
 const result=await pruneSourceSnapshots({...project,id},{getState:async()=>JSON.parse(await readFile(value('--state'),'utf8')),apply:args.includes('--apply')});
 console.log(JSON.stringify({project:id,...result}));
}
