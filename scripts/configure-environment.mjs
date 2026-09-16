import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { credential, boundedFetch } from '../src/runner/environment-connector.js';
import { createEnvironmentTools } from '../src/runner/environment-tools.js';
import { loadEnvironments } from '../src/shared/environment-access.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
const file = path.join(repo, 'config/environments.local.json');
if (!stdin.isTTY || process.platform !== 'darwin') throw new Error('Run this setup in a local macOS terminal');
let rl = createInterface({ input: stdin, output: stdout });
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
    // Namespace is discovered after local login; no dataId or group needs manual entry.
    e.baseUrl = new URL(e.baseUrl).origin + new URL(e.baseUrl).pathname.replace(/\/$/, '');
    e.queries.investigate = { reviewed: true, mode: 'investigate', browser: (await rl.question('启用独立浏览器查看当前Nacos？仅允许已选范围的只读页面操作 (yes/no): ')).trim() === 'yes', description: '在选定命名空间内自动发现配置、解析数据库地址；不连接数据库', namespaces: [''], parameters: [{ name: 'purpose', type: 'string', maxLength: 200 }], maxRows: 20, maxCalls: 8, timeoutMs: 5000 };
  } else throw new Error('Unsupported connector');
  if (kind === 'mysql' && (await rl.question('允许在本库基础表中按条件只读排查？结果对群可见，不提供SQL或写入工具 (yes/no): ')).trim() === 'yes') {
    e.queries.investigate = { reviewed: true, mode: 'investigate', description: '本库基础表结构及按条件只读查询，每次最多20行；不允许全表读取或写入', tables: ['*'], parameters: [{ name: 'purpose', type: 'string', maxLength: 200 }], maxRows: 20, maxCalls: 8, timeoutMs: 5000 };
  }
  let config = { version: 1, environments: {} }, original;
  try { original = await readFile(file); config = JSON.parse(original); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config.environments[name]?.kind === kind) e.queries = { ...config.environments[name].queries, ...e.queries };
  config.environments[name] = e;
  const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try { await loadEnvironments(temporary); } catch (error) { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw error; }
  console.log('Only the selected identity may approve PRD queries. No database/config write connector will be enabled.');
  if ((await rl.question('Save this environment and enter credentials in this terminal? (yes/no): ')).trim() !== 'yes') { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw new Error('Setup cancelled'); }
  rl.close();
  let saved;
  if(kind==='nacos' && e.queries.investigate?.browser){
    console.log('已打开独立浏览器。请在该窗口登录；认证成功后会自动返回，不要在群里发送密码。');
    const { loginNacosLocally } = await import('../src/runner/environment-browser.js');
    const localCredential = await loginNacosLocally(e.baseUrl);
    saved=spawnSync('python3',[path.join(repo,'scripts/keychain-credential.py'),'set-json',credentialRef],{input:JSON.stringify(localCredential),stdio:['pipe','ignore','pipe']});
  }else saved = spawnSync('python3', [path.join(repo, 'scripts/keychain-credential.py'), 'set', credentialRef], { stdio: 'inherit' });
  if (saved.status !== 0) { const { unlink } = await import('node:fs/promises'); await unlink(temporary); throw new Error('Credential setup did not complete; configuration unchanged'); }
  const cred = await credential(credentialRef);
  if (kind === 'nacos') {
    const base = e.baseUrl.replace(/\/$/, '');
    const login = JSON.parse(await boundedFetch(base + '/v1/auth/login', { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: cred.username, password: cred.password }) }));
    if (!login.accessToken) throw new Error('Login failed');
    const url = new URL(base + '/v2/console/namespace/list'); url.searchParams.set('accessToken', login.accessToken);
    const result = JSON.parse(await boundedFetch(url, { signal: AbortSignal.timeout(5000) }));
    if (result.code !== 0 || !Array.isArray(result.data) || result.data.length > 200) throw new Error('Namespace discovery failed');
    console.log('Nacos连接及登录成功。请选择允许读取的命名空间（可多选；不要把PRD空间放入UAT入口）。');
    result.data.forEach((x,i) => console.log(`${i+1}. ${String(x.namespaceShowName ?? '').replace(/[\x00-\x1f\x7f]/g,'').slice(0,100)}`));
    rl = createInterface({ input: stdin, output: stdout });
    const chosen = (await rl.question('输入序号，多个用逗号分隔: ')).split(',').map(x => Number(x.trim()) - 1);
    if (!chosen.length || chosen.some(i => !Number.isInteger(i) || !result.data[i])) throw new Error('Invalid selection');
    e.queries.investigate.namespaces = [...new Set(chosen.map(i => result.data[i].namespace))];
    e.queries.investigate.description = `所选命名空间内自动发现配置与解析数据库地址（${e.queries.investigate.namespaces.length}个空间），不连接数据库`;
    rl.close();
  } else {
    const { mysqlRead } = await import('../src/runner/environment-connector.js');
    await mysqlRead(e, e.queries.connection_check, [], cred);
    console.log('数据库连接及只读授权检查成功。');
  }
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await loadEnvironments(temporary);
  if (original) {
    const dir = path.join(repo, 'data/environment-config-backups', `${Date.now()}`); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'environments.local.json'), original, { mode: 0o400 });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length, beforeEnvironments: Object.keys(JSON.parse(original).environments).length, afterEnvironments: Object.keys(config.environments).length }), { mode: 0o400 });
  }
  await chmod(temporary, 0o600); await rename(temporary, file);
  console.log('环境已保存，连接已验证，无需重启。可在群里发起已授权范围的只读排查；数据库查询需要独立只读账号，Nacos登录不代表数据库已连接。');
} catch { console.error('Setup incomplete. Check non-secret environment fields, selected identity and local Keychain. No credentials printed.'); process.exitCode = 1; }
finally { rl.close(); }
