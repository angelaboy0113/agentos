import test from 'node:test';
import assert from 'node:assert/strict';
import {ProgressPublisher, isDisplayProgress} from '../src/runner/progress-publisher.js';
import {AgentRunner} from '../src/runner/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
test('a busy display receiver retains only the newest activity without blocking business tools', async () => {
  const calls = []; let release;
  const blocked = new Promise(resolve => release = resolve);
  const publisher = new ProgressPublisher(async event => { calls.push(event); if (calls.length === 1) await blocked; }, {intervalMs: 1000});
  await publisher.emit({type: 'progress', phase: 'tool_activity', activity: {total: 1}});
  await turn();
  for (let total = 2; total <= 1000; total++) await publisher.emit({type: 'progress', phase: 'tool_activity', activity: {total}});
  await publisher.emit({type: 'progress', phase: 'codex_working', elapsedSeconds: 13});
  assert.equal(calls.length, 1);
  assert.equal(publisher.pending.activity.total, 1000);
  let finished = false;
  const final = publisher.emit({type: 'completed', result: {outcome: 'ready', evidence: 'exact'}}).then(() => finished = true);
  await turn(); assert.equal(finished, false);
  release(); await final; await publisher.close();
  assert.deepEqual(calls.map(x => x.type), ['progress', 'progress', 'completed']);
  assert.equal(calls[1].activity.total, 1000);
  assert.equal(calls[1].phase, 'tool_activity'); assert.equal(calls[1].elapsedSeconds, 13);
  assert.equal(publisher.pending, null); assert.equal(publisher.timer, null);
});

test('source evidence, grants, failures and heartbeats are never display-coalesced', async () => {
  const calls = [], publisher = new ProgressPublisher(async event => { calls.push(event); return {ack: event.type}; });
  const events = [
    {type: 'progress', phase: 'tool_activity', sourceSnapshot: {commit: 'a'}},
    {type: 'progress', phase: 'codex_working', sourceContinuation: {threadId: 'b'}},
    {type: 'progress', phase: 'source_ready', sourceSnapshot: {commit: 'c'}},
    {type: 'heartbeat'}, {type: 'started'}, {type: 'codex_event', event: {type: 'turn.failed'}},
    {type: 'failed', result: {executionFailure: {code: 'DB_TIMEOUT'}}},
    {type: 'cancelled', processesExited: true},
  ];
  for (const event of events) { assert.equal(isDisplayProgress(event), false); assert.deepEqual(await publisher.emit(event), {ack: event.type}); }
  assert.deepEqual(calls, events); await publisher.close();
});

test('display failures cannot mask a final failure and terminal acknowledgement errors still propagate', async () => {
  const errors = [], publisher = new ProgressPublisher(async event => { throw Object.assign(new Error(event.type), {code: 'NETWORK'}); }, {onDisplayError: error => errors.push(error.message)});
  await publisher.emit({type: 'progress', phase: 'codex_working'});
  await assert.rejects(publisher.emit({type: 'failed', message: 'original DB failure'}), /failed/);
  await publisher.close(); assert.deepEqual(errors, ['progress']);
});

test('closing flushes the final display and refuses late callbacks without asynchronous sends', async () => {
  const calls = [], publisher = new ProgressPublisher(async event => calls.push(event));
  await publisher.emit({type: 'progress', phase: 'codex_working', elapsedSeconds: 1});
  await publisher.emit({type: 'progress', phase: 'codex_working', elapsedSeconds: 2});
  await publisher.close(); const n = calls.length;
  await publisher.emit({type: 'progress', phase: 'codex_working', elapsedSeconds: 3});
  await turn(); assert.equal(calls.length, n); assert.equal(calls.at(-1).elapsedSeconds, 2);
  await assert.rejects(publisher.emit({type: 'completed'}), /closed/);
});

test('eight parallel job publishers preserve independent identities, counters and result ordering', async () => {
  const seen = [];
  await Promise.all(Array.from({length: 8}, async (_, job) => {
    const publisher = new ProgressPublisher(async event => { seen.push({job, event}); await turn(); });
    for (let total = 1; total <= 500; total++) await publisher.emit({type: 'progress', phase: 'tool_activity', activity: {total}});
    await publisher.emit({type: 'completed', result: {job, total: 500}}); await publisher.close();
  }));
  for (let job = 0; job < 8; job++) {
    const events = seen.filter(x => x.job === job).map(x => x.event);
    assert.deepEqual(events.map(x => x.type), ['progress', 'progress', 'completed']);
    assert.equal(events[1].activity.total, 500); assert.equal(events[2].result.job, job);
  }
});

test('real runner transport coalesces only display pulses and durably sends final evidence', async () => {
  const calls = [], runner = new AgentRunner({runnerId: 'r'}, async (job, config, emit) => {
    for (let i = 0; i < 100; i++) await emit({type: 'progress', phase: 'tool_activity', activity: {total: i}});
    await emit({type: 'progress', phase: 'source_ready', sourceSnapshot: {commit: 'fixed'}});
    return {outcome: 'ready', finalMessage: 'evidence preserved'};
  });
  runner.post = async (url, event) => {
    if (url.endsWith('/control')) return {cancelRequested: false};
    calls.push(event); await turn(); return {job: {status: event.type === 'completed' ? 'completed' : 'running'}};
  };
  await runner.run({id: 'job', lease: {id: 'lease'}, taskIntent: 'analysis'});
  assert.equal(calls.filter(x => x.phase === 'tool_activity').length, 2);
  assert.equal(calls.at(-1).type, 'completed');
  assert.equal(calls.at(-2).sourceSnapshot.commit, 'fixed');
  for (const event of calls) { assert.equal(event.runnerId, 'r'); assert.equal(event.leaseId, 'lease'); }
});

test('a durable source acknowledgement timeout is reported rather than silently accepting missing evidence',async()=>{
 const calls=[],runner=new AgentRunner({runnerId:'r'},async(job,config,emit)=>{
   await emit({type:'progress',phase:'source_ready',sourceSnapshot:{commit:'fixed'}});
   return{outcome:'ready',finalMessage:'must not complete without receipt'};
 });
 runner.post=async(url,event)=>{if(url.endsWith('/control'))return{cancelRequested:false};calls.push(event);
   if(event.sourceSnapshot)throw Object.assign(new Error('source receipt unavailable'),{code:'LOCAL_CONTROL_TIMEOUT'});
   return{job:{status:event.type==='failed'?'failed':'running'}};
 };
 await runner.run({id:'job',lease:{id:'lease'},taskIntent:'analysis'});
 assert.equal(calls.some(x=>x.type==='completed'),false);assert.equal(calls.at(-1).type,'failed');assert.match(calls.at(-1).message,/LOCAL_CONTROL_TIMEOUT/);assert.match(calls.at(-1).message,/尚未确认/);
});
