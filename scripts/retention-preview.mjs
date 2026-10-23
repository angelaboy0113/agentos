// Read-only preview; never removes files or modifies state.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pruneState} from '../src/shared/retention.js';
const args=process.argv.slice(2);if(args.some((v,i)=>i%2===0&&v!=='--data-dir')||args.length%2)throw new Error('Usage: node scripts/retention-preview.mjs [--data-dir <directory>]');
const directory=path.resolve(args[1]??process.env.AGENTOS_DATA_DIR??'./data'),raw=await readFile(path.join(directory,'agentos.json'),'utf8'),state=JSON.parse(raw),now=Date.now(),days=Number(process.env.AGENTOS_RETENTION_DAYS??30);
const result=pruneState(state,{now,days});console.log(JSON.stringify({dryRun:true,days,cutoff:new Date(result.cutoff).toISOString(),counts:result.counts,protectedOld:result.protectedOld,stateBytesBefore:Buffer.byteLength(raw),stateBytesEstimatedAfter:Buffer.byteLength(JSON.stringify(state)),filesNotModified:true},null,2));
