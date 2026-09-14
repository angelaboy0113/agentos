// Opt-in real execution on synthetic files only. No Feishu, production jobs or business source.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { executeJob } from '../src/runner/codex-executor.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-folder-smoke-'));
const child = path.join(root, 'demo-child');
await mkdir(child);
await promisify(execFile)('git', ['-C', child, 'init'], { windowsHide: true });
const marker = `fixture-${randomUUID()}`;
await writeFile(path.join(child, '.gitignore'), 'local-note.txt\n');
await writeFile(path.join(child, 'local-note.txt'), marker);
await writeFile(path.join(root, 'plain-note.txt'), 'synthetic parent directory file');
const instruction = '这是合成测试目录，只读本目录的 plain-note.txt 和独立子仓 demo-child/local-note.txt，返回两个文件的原文以及相对路径。后者被 Git 忽略仍须读取。不要读取其他文件或父目录，不安装、不改文件、不执行网络请求。';
const result = await executeJob({ id: 'SYNTHETIC-READ', projectId: 'demo', stage: 'developer', taskIntent: 'analysis',
  workflow: 'analysis_review', instruction, attachments: [], context: [] },
  { executor: 'codex', projects: { demo: { repoPath: root } }, worktreeRoot: path.join(root, 'unused-trees') }, async () => {});
assert.equal(result.outcome, 'ready');
assert.ok(result.finalMessage.includes(marker));
assert.ok(result.finalMessage.includes('synthetic parent directory file'));
assert.equal(await readFile(path.join(child, 'local-note.txt'), 'utf8'), marker);
assert.deepEqual((await readdir(root)).sort(), ['demo-child', 'plain-note.txt']);
console.log(JSON.stringify({ outcome: result.outcome, rootIsNotGit: true, ignoredChildFileRead: true,
  filesUnchanged: true, ms: result.timing.totalMs }));
