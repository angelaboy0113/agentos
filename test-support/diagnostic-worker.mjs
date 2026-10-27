import {failureDetails} from '../src/shared/failure-diagnostic.js';
process.once('message',({job})=>{
 if(job.fixtureExit){process.exitCode=7;process.disconnect();return;}
 const error=Object.assign(new Error('fetch failed https://private.invalid/?token=synthetic-secret'),{cause:Object.assign(new Error('synthetic-secret'),{code:'ECONNRESET'}),diagnosticStage:'codex_execution'});
 process.send({type:'failure',failure:failureDetails(error)},()=>{process.exitCode=1;process.disconnect();});
});
