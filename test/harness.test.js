import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, cp } from 'node:fs/promises';
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

test('analysis handoff verifies same-task working evidence outside immutable source',async t=>{
 const root=await fixture(t),dataDir=path.join(root,'data');
 const {prepareArtifactWorkspace}=await import('../src/shared/artifact-workspace.js');
 const task={...job,id:'JOB-evidence-a'},working=await prepareArtifactWorkspace(dataDir,task.id);
 await writeFile(path.join(working.directory,'review.json'),' {"checked":true}');
 for(const ref of ['task-artifacts/review.json',path.join(working.directory,'review.json')]){
  const r=result();r.outcome='partial';r.handoff.risks=['历史信息未核实'];r.handoff.artifacts=[{kind:'report',path:ref}];
  const gate=await validateHandoff(task,r,root,{dataDir});assert.deepEqual(gate.issues,[]);
  assert.equal(gate.verifiedArtifacts[0].namespace,'task-working-evidence');assert.equal(gate.verifiedArtifacts[0].sourceJobId,task.id);
  assert.equal(gate.verifiedArtifacts[0].path,'task-artifacts/review.json');assert.equal(enforceHandoff(r,gate).outcome,'partial');
  assert.equal(gate.verifiedArtifacts[0].fileId,undefined); // Evidence is not a registered deliverable.
 }
});
test('working evidence cannot cross tasks, source boundary, credentials or implementation intent',async t=>{
 const root=await fixture(t),dataDir=path.join(root,'data');const{prepareArtifactWorkspace}=await import('../src/shared/artifact-workspace.js');
 const task={...job,id:'JOB-evidence-a'},a=await prepareArtifactWorkspace(dataDir,task.id),b=await prepareArtifactWorkspace(dataDir,'JOB-evidence-b');
 await writeFile(path.join(b.directory,'review.json'),'other task');await writeFile(path.join(a.directory,'.env'),'private');
 for(const ref of [path.join(b.directory,'review.json'),'task-artifacts/../review.json','task-artifacts/.env','task-artifacts/node_modules/review.json','task-artifacts/missing.json',path.join(root,'spec.md')]){
  const r=result();r.handoff.artifacts=[{kind:'report',path:ref}];assert.ok((await validateHandoff(task,r,root,{dataDir})).issues.length,ref);
 }
 const r=result();r.handoff.artifacts=[{kind:'report',path:'task-artifacts/review.json'}];
 assert.ok((await validateHandoff({...task,taskIntent:'implementation'},r,root,{dataDir})).issues.length);
});
test('working evidence rejects symbolic links and shared inodes, retains failed checks',async t=>{
 const root=await fixture(t),dataDir=path.join(root,'data');const{prepareArtifactWorkspace}=await import('../src/shared/artifact-workspace.js');
 const task={...job,id:'JOB-evidence-a'},a=await prepareArtifactWorkspace(dataDir,task.id);await writeFile(path.join(a.directory,'review.json'),'verified local evidence');
 const r=result();r.handoff.artifacts=[{kind:'decision',path:'task-artifacts/review.json'}];r.handoff.checks[0].status='failed';assert.ok((await validateHandoff(task,r,root,{dataDir})).issues.length);
 r.handoff.checks[0].status='passed';await symlink(path.join(root,'spec.md'),path.join(a.directory,'escape.json'));
 assert.ok((await validateHandoff(task,r,root,{dataDir})).issues.length);await rm(path.join(a.directory,'escape.json'));
 const{link}=await import('node:fs/promises');await link(path.join(root,'spec.md'),path.join(a.directory,'shared.json'));
 assert.ok((await validateHandoff(task,r,root,{dataDir})).issues.length);
});

test('reviewed source-metadata guidance resumes exact prior harnesses but rejects future role edits', async (t) => {
  const prior = ['f1805ef63e5b4708ea80ba561d845f704725c12dafc4dbd6ca3b4ef5755a6fd1','b198607138d3024b77424c518979dcb0898313d00bc1b5f8e8d5eaa7395b9ac7','37984a6bd108060a56eb996542aecfcc94275fd00ec6a01506458115b711c620'];
  for (const fingerprint of prior) {
    const h = await loadHarness({...job,context:[{result:{harness:{fingerprint}}}]});
    assert.deepEqual(h.metadata.reviewedPreviousFingerprints,[fingerprint]);
    assert.equal(h.metadata.contentFingerprint,'a24223832e96245e6c0f54371f91d5ed9ea57c1ef83741f723e7584540067672');
  }
  const directory=await fixture(t);await cp(new URL('../config/',import.meta.url),directory,{recursive:true});
  await writeFile(path.join(directory,'roles','common.md'),'Unreviewed future authority or guidance change');
  await assert.rejects(loadHarness({...job,context:[{result:{harness:{fingerprint:prior[0]}}}]},directory),/版本/);
});


test('read-only partial evidence can name a follow-up owner without becoming a failed handoff', async t => {
 const root=await fixture(t),r=result();r.outcome='partial';r.handoff.returnTo='owner';r.handoff.artifacts=[{kind:'code',path:'spec.md'}];r.handoff.risks=['Need original rule revision'];
 r.handoff.checks.push({id:'pending',required:true,status:'not_run',evidence:'Original revision unavailable'});
 const saved=JSON.stringify(r),gate=await validateHandoff(job,r,root);assert.deepEqual(gate.issues,[]);assert.equal(enforceHandoff(r,gate).outcome,'partial');assert.equal(JSON.stringify(r),saved);assert.equal(r.handoff.returnTo,'owner');
 const ready={...r,outcome:'ready'};assert.ok((await validateHandoff(job,ready,root)).issues.some(x=>x.includes('退回责任')));
 assert.ok((await validateHandoff({...job,taskIntent:'implementation'},r,root)).issues.some(x=>x.includes('partial只允许')));
 const failed=structuredClone(r);failed.handoff.checks[1].status='failed';assert.ok((await validateHandoff(job,failed,root)).issues.some(x=>x.includes('必需验收项失败')));
 const missing=structuredClone(r);missing.handoff.artifacts[0].path='missing.md';assert.ok((await validateHandoff(job,missing,root)).issues.length);
});
