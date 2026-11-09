import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {saveEncryptedCredential} from './credential-vault.js';

const helper = fileURLToPath(new URL('../../scripts/keychain-credential.py', import.meta.url));

export async function saveKeychainCredential(ref, value) {
  // The encrypted user-only vault is authoritative for unattended service
  // reads. Keychain mirroring is opt-in because its per-binary ACL may display
  // a macOS password dialog and therefore cannot be on the service hot path.
  await saveEncryptedCredential(ref,value);
  if(process.env.AGENTOS_KEYCHAIN_MIRROR!=='1')return;
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/python3', [helper, 'set-json', ref], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 1_500);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(value));
  });
}
