import { spawn } from 'node:child_process';
process.once('message', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  process.send({ type: 'event', event: { type: 'fixture_ready', parentPid: process.pid, childPid: child.pid } });
  setInterval(() => {}, 1000);
});
