import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadHarness, handoffContext, validateHandoff, enforceHandoff } from '../src/runner/harness.js';
import { conversationProject } from '../src/control-plane/conversations.js';

const job = { stage: 'developer', taskIntent: 'analysis', context: [] };
const result = () => ({ outcome: 'ready', summary: '发现', finalMessage: '证据', handoff: {
  artifacts: [], checks: [{ id: 'AC-1', required: true, status: 'passed', evidence: '已核查源码' }], risks: [], returnTo: 'none' } });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-harness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'spec.md'), 'AC-1: demo');
  return root;
}
test('standard manifest and all roles load fail-closed and pin mission fingerprint', async (t) => {
  const h = await loadHarness(job);
  assert.equal(h.metadata.standard.revision, 334);
  assert.match(h.instruction, /Observability-Driven Development/);
  assert.match(h.instruction, /只读调查职责/);
  assert.equal((await loadHarness({ ...job, stage: 'owner_report', context: [{ result: { harness: h.metadata } }] })).metadata.fingerprint, h.metadata.fingerprint);
  await assert.rejects(loadHarness({ ...job, context: [{ result: { harness: { fingerprint: 'old' } } }] }), /版本/);
  await assert.rejects(loadHarness(job, await fixture(t)), /ENOENT/);
  for (const stage of ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report']) {
    assert.match((await loadHarness({ stage, taskIntent: 'implementation' })).instruction, /交付|交接/);
  }
});
test('artifacts get actual content hashes; missing and traversal paths block', async (t) => {
  const root = await fixture(t), r = result();
  r.handoff.artifacts = [{ kind: 'spec', path: 'spec.md' }];
  const first = await validateHandoff(job, r, root);
  assert.deepEqual(first.issues, []);
  assert.equal(first.verifiedArtifacts[0].sha256.length, 64);
  await writeFile(path.join(root, 'spec.md'), 'changed');
  assert.notEqual((await validateHandoff(job, r, root)).verifiedArtifacts[0].sha256, first.verifiedArtifacts[0].sha256);
  for (const name of ['missing.md', '../spec.md', '.env', 'auth.json', 'C:/foreign.md', 'spec.md:secret']) {
    r.handoff.artifacts = [{ kind: 'spec', path: name }];
    assert.ok((await validateHandoff(job, r, root)).issues.length);
  }
});
test('directory links outside artifact workspace are rejected', async (t) => {
  const root = await fixture(t), outside = await fixture(t);
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = result(); r.handoff.artifacts = [{ kind: 'spec', path: 'escape/spec.md' }];
  assert.ok((await validateHandoff(job, r, root)).issues.length);
});
test('required failed/unexecuted checks and return requests never become ready', async (t) => {
  const root = await fixture(t);
  for (const status of ['failed', 'not_run', 'not_applicable']) {
    const r = result(); r.handoff.checks[0].status = status;
    const gate = await validateHandoff(job, r, root);
    assert.equal(enforceHandoff(r, gate).outcome, 'blocked');
  }
  const r = result(); r.handoff.returnTo = 'developer';
  assert.ok((await validateHandoff(job, r, root)).issues.length);
});
test('PM and implementation require artifacts while analysis and intake remain lightweight', async (t) => {
  const root = await fixture(t), r = result();
  assert.deepEqual((await validateHandoff(job, r, root)).issues, []);
  assert.deepEqual((await validateHandoff({ stage: 'owner_intake' }, r, root)).issues, []);
  assert.ok((await validateHandoff({ stage: 'pm', taskIntent: 'planning' }, r, root)).issues.length);
  assert.ok((await validateHandoff({ stage: 'developer', taskIntent: 'implementation' }, r, root)).issues.length);
  r.handoff.artifacts = [{ kind: 'prd', path: 'spec.md' }, { kind: 'spec', path: 'spec.md' }];
  assert.deepEqual((await validateHandoff({ stage: 'pm' }, r, root)).issues, []);
  assert.deepEqual((await validateHandoff({ stage: 'developer' }, r, root)).issues, []);
});
test('missing/malformed/duplicate/empty evidence is blocked rather than approved', async (t) => {
  const root = await fixture(t);
  assert.ok((await validateHandoff(job, { outcome: 'ready' }, root)).issues.length);
  for (const checks of [[null], [], [{ id: 'AC', required: true, status: 'passed', evidence: '' }], [result().handoff.checks[0], result().handoff.checks[0]]]) {
    const r = result(); r.handoff.checks = checks;
    assert.ok((await validateHandoff(job, r, root)).issues.length);
  }
});
test('QA and audit get artifact references without author narrative; reporting keeps bounded details', () => {
  const context = [{ stage: 'developer', result: { summary: 'AUTHOR_SELF_PRAISE', finalMessage: 'RAW_AUTHOR_NARRATIVE', handoff: result().handoff, verifiedArtifacts: [{ path: 'spec.md' }] } }];
  for (const stage of ['qa', 'owner_audit']) {
    const value = JSON.stringify(handoffContext({ stage, context }));
    assert.doesNotMatch(value, /AUTHOR_SELF_PRAISE|RAW_AUTHOR_NARRATIVE/);
    assert.match(value, /spec.md/);
  }
  assert.match(JSON.stringify(handoffContext({ stage: 'owner_report', context })), /RAW_AUTHOR_NARRATIVE/);
});
test('legacy session key preserves known project identity, unknown history stays unassigned', () => {
  assert.equal(conversationProject({ sessionKey: JSON.stringify(['group', 'user', 'bot', 'role', 'a']) }), 'a');
  assert.equal(conversationProject({ projectId: 'b', sessionKey: 'bad' }), 'b');
  assert.equal(conversationProject({ sessionKey: 'bad' }), undefined);
});
