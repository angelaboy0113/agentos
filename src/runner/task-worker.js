import {maintenanceCheckpoint} from './maintenance-checkpoint.js';
import {fenceParentExit} from './parent-exit.js';
const normalDisconnect=fenceParentExit();
import { executeEnvironmentJob } from './environment-job.js';
import { executeJob } from './codex-executor.js';
import {failureDetails} from '../shared/failure-diagnostic.js';
import {nativeGrantedEntry} from './investigation-entry.js';

process.once('message', async ({ job, config }) => {
  const send = (message) => new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Runner disconnected'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
  try {
    const result = await maintenanceCheckpoint(job,config)??await (job.environmentAccess&&!nativeGrantedEntry(job,config) ? executeEnvironmentJob : executeJob)(job, config, (event) => send({ type: 'event', event }));
    await send({ type: 'result', result });
  } catch (error) {
    await send({ type: 'failure', failure:failureDetails(error,{stage:job.environmentAccess?'environment_read':'source_analysis'}) }).catch(() => undefined);
    process.exitCode = 1;
  } finally {normalDisconnect();if (process.connected) process.disconnect(); }
});
