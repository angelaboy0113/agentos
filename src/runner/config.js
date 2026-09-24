import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function runnerConfig(overrides = {}) {
  const projectsFile = overrides.projectsFile ?? process.env.AGENTOS_PROJECTS_FILE ?? './config/projects.local.json';
  let projects = overrides.projects;
  if (!projects) {
    const parsed = JSON.parse(await readFile(path.resolve(projectsFile), 'utf8'));
    projects = parsed.projects ?? {};
  }
  const concurrency = Number(overrides.concurrency ?? process.env.AGENTOS_RUNNER_CONCURRENCY ?? 3);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('AGENTOS_RUNNER_CONCURRENCY must be an integer from 1 to 8');
  const analysisTurnTimeoutMs = Number(overrides.analysisTurnTimeoutMs ?? process.env.AGENTOS_ANALYSIS_TURN_TIMEOUT_MS ?? 900000);
  const analysisResumeTimeoutMs = Number(overrides.analysisResumeTimeoutMs ?? process.env.AGENTOS_ANALYSIS_RESUME_TIMEOUT_MS ?? 480000);
  if (!Number.isInteger(analysisTurnTimeoutMs) || analysisTurnTimeoutMs < 60000 || analysisTurnTimeoutMs > 3600000) throw new Error('AGENTOS_ANALYSIS_TURN_TIMEOUT_MS must be 60000..3600000');
  if (!Number.isInteger(analysisResumeTimeoutMs) || analysisResumeTimeoutMs < 60000 || analysisResumeTimeoutMs > 1800000) throw new Error('AGENTOS_ANALYSIS_RESUME_TIMEOUT_MS must be 60000..1800000');
  return {
    serverUrl: String(overrides.serverUrl ?? process.env.AGENTOS_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    runnerId: overrides.runnerId ?? process.env.AGENTOS_RUNNER_ID ?? `runner-${process.platform}-${process.pid}`,
    runnerToken: overrides.runnerToken ?? process.env.AGENTOS_RUNNER_TOKEN ?? '',
    pollMs: Number(overrides.pollMs ?? process.env.AGENTOS_RUNNER_POLL_MS ?? 3000),
    worktreeRoot: path.resolve(overrides.worktreeRoot ?? process.env.AGENTOS_RUNNER_WORKTREE_ROOT ?? './data/worktrees'),
    executor: overrides.executor ?? process.env.AGENTOS_RUNNER_EXECUTOR ?? 'mock',
    codexBin: overrides.codexBin ?? process.env.CODEX_BIN ?? 'codex',
    concurrency,
    analysisTurnTimeoutMs,
    analysisResumeTimeoutMs,
    projects,
  };
}
