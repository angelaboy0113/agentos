import { fileURLToPath } from 'node:url';
import { runnerConfig } from './config.js';
import { executeTaskProcess } from './task-process.js';

export class AgentRunner {
  constructor(config, execute = executeTaskProcess) {
    this.config = config;
    this.execute = execute;
    this.stopped = false;
  }

  async start() {
    if (!this.config.runnerToken) throw new Error('AGENTOS_RUNNER_TOKEN is required');
    console.log(`[runner] ${this.config.runnerId} started with ${this.config.executor} executor`);
    while (!this.stopped) {
      try {
        await this.heartbeat();
        const job = await this.lease();
        if (job) await this.run(job);
      } catch (error) {
        console.error('[runner]', error.message);
      }
      if (!this.stopped) await delay(this.config.pollMs);
    }
  }

  stop() { this.stopped = true; }

  heartbeat() {
    return this.post('/api/v1/runners/heartbeat', {
      runnerId: this.config.runnerId,
      platform: process.platform,
      nodeVersion: process.version,
      executor: this.config.executor,
      capabilities: ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report'],
    });
  }

  async lease() {
    const response = await this.post('/api/v1/jobs/lease', {
      runnerId: this.config.runnerId,
      capabilities: ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report'],
    });
    return response.job;
  }

  async run(job) {
    const identity = { runnerId: this.config.runnerId, leaseId: job.lease.id };
    const emit = (event) => this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/events`, { ...event, ...identity });
    const controller = new AbortController();
    let checking = false;
    let lostLease = false;
    const checkControl = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const control = await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/control`, identity);
        if (control.cancelRequested) controller.abort();
      } catch (error) {
        if (error.statusCode === 409) { lostLease = true; controller.abort(); }
        else console.warn(`[runner] cancellation control unavailable for ${job.id}`);
      } finally { checking = false; }
    };
    await emit({ type: 'started', runnerId: this.config.runnerId });
    const controlTimer = setInterval(checkControl, 1500);
    controlTimer.unref();
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(async () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await emit({ type: 'heartbeat', runnerId: this.config.runnerId });
      } catch (error) {
        console.warn(`[runner] failed to renew lease for ${job.id}: ${error.message}`);
      } finally {
        heartbeatInFlight = false;
      }
    }, 30_000);
    heartbeatTimer.unref();
    try {
      await checkControl();
      if (controller.signal.aborted) {
        if (!lostLease) await emit({ type: 'cancelled', processesExited: true });
        return;
      }
      const result = await this.executeContinuous(job, emit, controller.signal);
      const completed = await emit({ type: 'completed', result });
      // Cancellation may win the transaction race just after the worker exited naturally.
      if (completed.job.status === 'cancelling') await emit({ type: 'cancelled', processesExited: true });
    } catch (error) {
      if (controller.signal.aborted && error.processesExited === false) {
        this.stopped = true; // Never lease another task while the old process may still be writing.
        console.error(`[runner] ${job.id}: stop could not be verified; Runner paused for manual inspection`);
      }
      if (!lostLease) await emit(controller.signal.aborted && error.processesExited
        ? { type: 'cancelled', processesExited: true }
        : { type: 'failed', message: error.message, result: { error: error.message } });
    } finally {
      clearInterval(controlTimer);
      clearInterval(heartbeatTimer);
    }
  }

  async executeContinuous(job, emit, signal) {
    if (!job.continuousInvestigation || job.taskIntent !== 'analysis' || job.stage !== 'developer') {
      return this.execute(job, this.config, emit, signal);
    }
    const identity = { runnerId: this.config.runnerId, leaseId: job.lease.id };
    let current = job;
    if (current.environmentAccess) {
      const environmentResult = await this.execute(current, this.config, emit, signal);
      if (!['ready', 'partial'].includes(environmentResult?.outcome) || environmentResult.browserLoginRequired) return environmentResult;
      current = (await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-environment-result`,
        { ...identity, result: environmentResult })).job;
    }
    for (;;) {
      signal.throwIfAborted();
      const result = await this.execute(current, this.config, emit, signal);
      if (result?.outcome !== 'needs_clarification' || (!result.environmentQuery && !result.websiteQuery)) return result;
      const prepared = await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-environment`,
        { ...identity, result });
      current = prepared.job;
      if (prepared.terminalResult) return prepared.terminalResult;
      if (!prepared.planned) continue;
      const environmentResult = await this.execute(current, this.config, emit, signal);
      if (!['ready', 'partial'].includes(environmentResult?.outcome) || environmentResult.browserLoginRequired) return environmentResult;
      current = (await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-environment-result`,
        { ...identity, result: environmentResult })).job;
    }
  }

  async post(path, body) {
    const response = await fetch(`${this.config.serverUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${path} failed (${response.status}): ${payload.error ?? 'unknown error'}`);
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }
}

export function createRunnerPool(config, execute = executeTaskProcess) {
  return Array.from({ length: config.concurrency }, (_, index) => new AgentRunner({ ...config,
    runnerId: config.concurrency === 1 ? config.runnerId : `${config.runnerId}-${index + 1}` }, execute));
}

async function main() {
  const config = await runnerConfig();
  const runners = createRunnerPool(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runners.forEach((runner) => runner.stop()));
  await Promise.all(runners.map((runner) => runner.start()));
}

const current = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (process.argv[1] && current === process.argv[1]) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
