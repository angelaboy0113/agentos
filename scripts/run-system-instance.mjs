import { readFile, realpath, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadProjects, loadAgents } from '../src/control-plane/config.js';

const program = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.dirname(program);
const runtime = path.join(bundle, 'runtime');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--start'].includes(mode)) throw new Error('Use --check or --start');
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('请用 Node 22 启动独立实例');
const instance = JSON.parse(await readFile(path.join(runtime, 'instance.local.json'), 'utf8'));
const branch = execFileSync('git', ['-C', program, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
if (branch !== instance.branch) throw new Error('当前分支不属于本实例，拒绝启动');
if (!Number.isInteger(instance.port) || instance.port < 1024 || instance.port > 65535 || (instance.protectedPorts ?? []).includes(instance.port)) throw new Error('实例端口无效或与受保护实例冲突');
const inside = (root, child) => { const rel = path.relative(root, child); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
for (const name of ['runtime', 'systems']) {
  const target = await realpath(path.join(bundle, name));
  if (!inside(await realpath(bundle), target)) throw new Error('实例目录存在越界符号链接');
}
const configDir = path.join(program, 'config');
const projects = await loadProjects(path.join(configDir, 'projects.local.json'));
const { agents } = await loadAgents(path.join(configDir, 'agents.local.json'));
const pending = [];
for (const [key, agent] of Object.entries(agents)) {
  if (!agent.systemAssistant || !agent.profile || !agent.allowedChatIds?.length) throw new Error(`无效系统助手配置：${key}`);
  if (!agent.openId || !projects.ownerOpenIdsByProfile?.[agent.profile]?.length) pending.push(`${agent.displayName}：机器人身份/群主身份待核验`);
  for (const chat of agent.allowedChatIds) if (projects.chatProfileProjectMap?.[chat]?.[agent.profile] !== agent.projectId) throw new Error(`群/系统绑定不一致：${key}`);
}
const authFile = path.join(runtime, 'lark-cli', 'config.json');
try { await access(authFile); } catch { pending.push('新实例飞书凭据尚未配置'); }
for (const project of Object.values(projects.projects)) {
  if (!inside(path.join(bundle, 'systems'), await realpath(project.repoPath))) throw new Error('业务源码目录越出新实例');
  for (const env of Object.values(project.analysisEnvironments ?? {})) for (const repo of env.repositories) {
    try { await access(path.join(project.repoPath, repo.path, '.git')); } catch { pending.push(`缺少源码仓：${repo.path}`); }
  }
}
console.log(JSON.stringify({ branch, port: instance.port, assistants: Object.values(agents).map(a => a.displayName), pending: [...new Set(pending)], readyToStart: !pending.length }, null, 2));
if (mode === '--check') process.exit(pending.length ? 2 : 0);
if (pending.length) throw new Error('接入尚未完成，拒绝连接事件或启动服务');
for (const key of Object.keys(process.env)) if (/^(AGENTOS_|FEISHU_|LARKSUITE_CLI_CONFIG_DIR$)/.test(key)) delete process.env[key];
Object.assign(process.env, {
  AGENTOS_HOST: '127.0.0.1', AGENTOS_PORT: String(instance.port),
  AGENTOS_DATA_DIR: path.join(runtime, 'data'), AGENTOS_RUNNER_WORKTREE_ROOT: path.join(runtime, 'data', 'worktrees'),
  AGENTOS_BROWSER_MODE: 'isolated', AGENTOS_RUNNER_CONCURRENCY: String(instance.concurrency ?? 3),
  LARKSUITE_CLI_CONFIG_DIR: path.dirname(authFile), AGENTOS_LARK_CONFIG_FILE: authFile,
});
for (const [key, filename] of Object.entries({ PROJECTS: 'projects', AGENTS: 'agents', ENVIRONMENTS: 'environments', CONVERSATION: 'conversation', MEMORY: 'memory', KNOWLEDGE: 'knowledge', CONTACTS: 'contacts', CONTACT_CHANNELS: 'contact-channels', CODEX_RUNTIME: 'codex-runtime' })) process.env[`AGENTOS_${key}_FILE`] = path.join(configDir, `${filename}.local.json`);
await mkdir(process.env.AGENTOS_DATA_DIR, { recursive: true, mode: 0o700 });
process.chdir(program);
await import('../src/control-plane/local.js');
