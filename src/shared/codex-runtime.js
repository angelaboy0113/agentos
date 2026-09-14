import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localFile = fileURLToPath(new URL('../../config/codex-runtime.local.json', import.meta.url));

export async function resolveCodexBinary(explicit, options = {}) {
  if (explicit && explicit !== 'codex') return explicit;
  if (process.env.CODEX_BIN && process.env.CODEX_BIN !== 'codex') return process.env.CODEX_BIN;
  let local = {};
  try { local = JSON.parse(await readFile(localFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (local.codexBin && local.codexBin !== 'codex') {
    try { if ((await stat(local.codexBin)).isFile()) return local.codexBin; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return await discoverWindowsCodexBinary(options.discoveryRoot) || 'codex';
}

export async function discoverWindowsCodexBinary(root = null) {
  if (!root && process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binRoot = root || path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try { entries = await readdir(binRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(binRoot, entry.name, 'codex.exe');
    try {
      const details = await stat(candidate);
      if (details.isFile()) candidates.push({ path: candidate, modified: details.mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.path ?? null;
}

// Scoped only to Codex children. Never changes Windows, Feishu, model or auth.
export async function codexEnvironment(options = {}) {
  let local = {};
  try { local = JSON.parse(await readFile(options.file ?? localFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const proxyConfigured = Object.hasOwn(options, 'proxyUrl')
    || process.env.AGENTOS_CODEX_PROXY_URL !== undefined || Object.hasOwn(local, 'proxyUrl');
  const proxy = options.proxyUrl ?? process.env.AGENTOS_CODEX_PROXY_URL ?? local.proxyUrl;
  const env = { ...process.env };
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:', 'socks5h:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Codex proxy must use http/https/socks5h without embedded credentials');
    }
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  } else if (proxyConfigured) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete env[key];
  }
  return env;
}

export function conversationServerArgs() {
  return ['app-server', '--stdio',
    '-c', 'features.plugins=false', '-c', 'features.apps=false',
    '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false',
    '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
    '-c', 'features.image_generation=false', '-c', 'web_search="disabled"',
    '-c', 'features.unbounded_connection_retries=false'];
}
