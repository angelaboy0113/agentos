import { executeJob } from './codex-executor.js';

process.once('message', async ({ job, config }) => {
  const send = (message) => new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Runner disconnected'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
  try {
    const result = await executeJob(job, config, (event) => send({ type: 'event', event }));
    await send({ type: 'result', result });
  } catch (error) {
    await send({ type: 'failure', message: error.message }).catch(() => undefined);
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
});
