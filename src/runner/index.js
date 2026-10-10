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
      if (!['ready', 'partial'].includes(environmentResult?.outcome) || environmentResult.browserLoginRequired) {
        return preserveContinuousEnvironmentEvidence(current, environmentResult);
      }
      current = (await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-environment-result`,
        { ...identity, result: environmentResult })).job;
    }
    for (;;) {
      signal.throwIfAborted();
      const result = await this.execute(current, this.config, emit, signal);
      if (result?.outcome === 'partial' && result.investigation?.status === 'continue' && !result.investigation?.blocker) {
        const continued = await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-analysis-continue`,
          { ...identity, result });
        if (!continued.continued) return continued.terminalResult ?? result;
        current = continued.job;
        continue;
      }
      if (result?.outcome !== 'needs_clarification' || (!result.environmentQuery && !result.websiteQuery)) return result;
      const prepared = await this.post(`/api/v1/jobs/${encodeURIComponent(job.id)}/continuous-environment`,
        { ...identity, result });
      current = prepared.job;
      if (prepared.terminalResult) return prepared.terminalResult;
      if (!prepared.planned) continue;
      const environmentResult = await this.execute(current, this.config, emit, signal);
      if (!['ready', 'partial'].includes(environmentResult?.outcome) || environmentResult.browserLoginRequired) {
        return preserveContinuousEnvironmentEvidence(current, environmentResult);
      }
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

// A later supplementary environment read must not erase source-backed findings
// that already passed the analysis handoff gate. Browser/database interruptions
// remain visible as an explicit gap; without useful prior evidence the original
// blocked result is returned unchanged.
export function preserveContinuousEnvironmentEvidence(job, environmentResult) {
  if (environmentResult?.outcome !== 'blocked' || environmentResult.browserLoginRequired) return environmentResult;
  const prior = [...(job.context ?? [])].reverse().find((entry) => {
    const result = entry.kind === 'analysis_turn' ? entry.result : null;
    return result?.handoffGate?.passed === true
      && result.verifiedArtifacts?.length > 0
      && result.handoff?.checks?.some((check) => check?.status === 'passed')
      && typeof result.finalMessage === 'string' && result.finalMessage.trim();
  })?.result;
  if (!prior) return environmentResult;
  const diagnostic = String(environmentResult.finalMessage ?? environmentResult.summary ?? '补充环境读取未完成。').slice(0, 2000);
  const risk = `补充环境核验未完成：${diagnostic.replace(/\s+/g, ' ').slice(0, 500)}`;
  const investigation = prior.investigation ? {
    ...prior.investigation,
    status: 'wait',
    blocker: { kind: 'unavailable', needed: '恢复受控只读环境连接后补充核验', evidence: diagnostic.slice(0, 1000) },
    nextStep: '恢复对应只读环境连接后，仅补查尚未核实的页面或运行态证据。',
  } : prior.investigation;
  return {
    ...prior,
    outcome: 'partial',
    summary: `已保留前面查明的结论；最后一次补充环境核验未完成。${prior.summary ?? ''}`.slice(0, 1200),
    finalMessage: `${prior.finalMessage}\n\n尚未完成的补充核验\n${diagnostic}\n\n以上连接异常只影响补充核验，不推翻前面已经取得的源码或数据库证据。`,
    environmentSetup: null,
    environmentQuery: null,
    websiteQuery: null,
    investigation,
    handoff: prior.handoff ? {
      ...prior.handoff,
      returnTo: 'none',
      risks: [...new Set([...(prior.handoff.risks ?? []), risk])],
    } : prior.handoff,
  };
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
