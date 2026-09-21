import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../scripts/keychain-credential.py', import.meta.url));

export function saveKeychainCredential(ref, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helper, 'set-json', ref], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('本机钥匙串保存超时')); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('本机钥匙串不可写入')); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code ? reject(new Error('本机钥匙串不可写入；请解锁当前用户的登录钥匙串')) : resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(value));
  });
}
