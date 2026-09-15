import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEnvironments } from '../src/shared/environment-access.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
const file = path.join(repo, 'config/environments.local.json');
if (!stdin.isTTY || process.platform !== 'darwin') throw new Error('Run this setup in a local macOS terminal');
const rl = createInterface({ input: stdin, output: stdout });
try {
  const projects = JSON.parse(await readFile(path.join(repo, 'config/projects.local.json'), 'utf8'));
  const projectEntries = Object.entries(projects.projects);
  projectEntries.forEach(([id, p], i) => console.log(`${i + 1}. ${p.displayName ?? id}`));
  const project = projectEntries[Number(await rl.question('Project number: ')) - 1]; if (!project) throw new Error('Invalid project');
  const identities = Object.entries(projects.humanIdentities ?? {}).filter(([, mapping]) => Object.entries(mapping).some(([p, id]) => projects.ownerOpenIdsByProfile?.[p]?.includes(id)));
  if (!identities.length) throw new Error('Configure the environment owner human identity locally before setup');
  identities.forEach(([name], i) => console.log(`${i + 1}. ${name}`));
  const identity = identities.length === 1 ? identities[0] : identities[Number(await rl.question('Your administrator identity number: ')) - 1];
  if (!identity) throw new Error('Invalid administrator identity');
  const ownerOpenIdsByProfile = Object.fromEntries(Object.entries(identity[1]).filter(([p, id]) => projects.ownerOpenIdsByProfile?.[p]?.includes(id)).map(([p, id]) => [p, [id]]));
  const tier = (await rl.question('Environment tier (uat/prd): ')).trim();
  const kind = (await rl.question('Connector (mysql/nacos): ')).trim();
  const name = (await rl.question(`Environment alias (example ${tier}-${kind}): `)).trim();
  const credentialRef = name;
  const e = { projectId: project[0], tier, kind, credentialRef, ownerOpenIdsByProfile,
    membersRead: tier === 'uat' && (await rl.question('Allow member UAT read queries without per-request approval? (yes/no): ')).trim() === 'yes', queries: {} };
  if (kind === 'mysql') {
    e.host = (await rl.question('MySQL host (no username/password): ')).trim(); e.port = Number((await rl.question('Port [3306]: ')).trim() || '3306');
    e.database = (await rl.question('Database name: ')).trim(); e.tls = (await rl.question('Require TLS certificate verification? (yes/no): ')).trim() === 'yes';
    e.queries.connection_check = { reviewed: true, description: '验证只读数据库连接，返回当前库名和数据库时间', sql: 'SELECT DATABASE() AS database_name, CURRENT_TIMESTAMP() AS checked_at',
      parameters: [], outputColumns: ['database_name', 'checked_at'], maxRows: 1, timeoutMs: 5000 };
  } else if (kind === 'nacos') {
    e.baseUrl = (await rl.question('Nacos base URL ending in /nacos (no login fragment): ')).trim();
    const namespace = (await rl.question('Exact namespace ID (empty for public): ')).trim(), group = (await rl.question('Config group [DEFAULT_GROUP]: ')).trim() || 'DEFAULT_GROUP', dataId = (await rl.question('Exact config dataId: ')).trim();
    e.queries.database_endpoints = { reviewed: true, description: '读取指定Nacos配置，仅返回MySQL主机和库名，不返回账号密码', namespace, group, dataId, parameters: [], maxRows: 20, timeoutMs: 5000 };
  } else throw new Error('Unsupported connector');
  let config = { version: 1, environments: {} }, original;
  try { original = await readFile(file); config = JSON.parse(original); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config.environments[name]?.kind === kind) e.queries = { ...config.environments[name].queries, ...e.queries };
  config.environments[name] = e;
  const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try { await loadEnvironments(temporary); } catch (error) { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw error; }
  console.log('Only the selected identity may approve PRD queries. No database/config write connector will be enabled.');
  if ((await rl.question('Save this environment and enter credentials in this terminal? (yes/no): ')).trim() !== 'yes') { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw new Error('Setup cancelled'); }
  rl.close();
  const saved = spawnSync('python3', [path.join(repo, 'scripts/keychain-credential.py'), 'set', credentialRef], { stdio: 'inherit' });
  if (saved.status !== 0) { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw new Error('Credential setup did not complete; configuration unchanged'); }
  if (original) {
    const dir = path.join(repo, 'data/environment-config-backups', `${Date.now()}`); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'environments.local.json'), original, { mode: 0o400 });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length, beforeEnvironments: Object.keys(JSON.parse(original).environments).length, afterEnvironments: Object.keys(config.environments).length }), { mode: 0o400 });
  }
  await chmod(temporary, 0o600); await rename(temporary, file);
  console.log('Environment configured locally. New requests can discover it without restarting AgentOS. Business queries still require locally reviewed templates.');
} catch { console.error('Setup incomplete. Check non-secret environment fields, selected identity and local Keychain. No credentials printed.'); process.exitCode = 1; }
finally { rl.close(); }
