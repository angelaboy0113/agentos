import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateHumanIdentities } from './authorization.js';

export function controlConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.AGENTOS_DATA_DIR ?? './data');
  return {
    host: overrides.host ?? process.env.AGENTOS_HOST ?? '127.0.0.1',
    port: Number(overrides.port ?? process.env.AGENTOS_PORT ?? 8787),
    dataDir,
    storeFile: overrides.storeFile ?? path.join(dataDir, 'agentos.json'),
    projectsFile: overrides.projectsFile ?? process.env.AGENTOS_PROJECTS_FILE ?? './config/projects.local.json',
    agentsFile: overrides.agentsFile ?? process.env.AGENTOS_AGENTS_FILE ?? './config/agents.local.json',
    adminToken: overrides.adminToken ?? process.env.AGENTOS_ADMIN_TOKEN ?? '',
    runnerToken: overrides.runnerToken ?? process.env.AGENTOS_RUNNER_TOKEN ?? '',
    feishu: {
      transport: overrides.feishu?.transport ?? process.env.FEISHU_TRANSPORT ?? 'openapi',
      appId: overrides.feishu?.appId ?? process.env.FEISHU_APP_ID ?? '',
      appSecret: overrides.feishu?.appSecret ?? process.env.FEISHU_APP_SECRET ?? '',
      verificationToken: overrides.feishu?.verificationToken ?? process.env.FEISHU_VERIFICATION_TOKEN ?? '',
      cliEntry: overrides.feishu?.cliEntry ?? process.env.LARK_CLI_ENTRY ?? '',
    },
  };
}

export async function loadAgents(file) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    return { agents: parsed.agents ?? {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { agents: {} };
    throw error;
  }
}

export async function loadProjects(file) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    return {
      ownerOpenIds: parsed.ownerOpenIds ?? [],
      ownerOpenIdsByProfile: parsed.ownerOpenIdsByProfile ?? {},
      humanIdentities: validateHumanIdentities(parsed.humanIdentities ?? {}),
      chatProjectMap: parsed.chatProjectMap ?? {},
      projects: parsed.projects ?? {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { ownerOpenIds: [], ownerOpenIdsByProfile: {}, chatProjectMap: {}, projects: {} };
    throw error;
  }
}

export async function saveProjects(file, projects) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}
