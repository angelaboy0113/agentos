import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  enrollmentTarget,
  requestEnrollment,
  approveEnrollment,
  pollEnrollments,
} from "../src/control-plane/environment-enrollment.js";
import { planQuery } from "../src/shared/environment-access.js";
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agentos-enrollment-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const turn = {
    id: "turn",
    questionId: "q",
    chatId: "group",
    profile: "owner",
    senderId: "ou_member",
    status: "sent",
    decision: {
      action: "request_environment_setup",
      instruction: "检查配置中的数据库地址",
      environmentSetup: {
        kind: "nacos",
        tier: "prd",
        url: "http://example.test:8848/nacos",
      },
    },
  };
  const state = {
    jobs: [],
    conversations: [turn],
    questions: { q: { id: "q", latestTurnId: "turn", generation: 1 } },
  };
  const context = {
    config: { dataDir },
    projects: {
      chatProjectMap: { group: "demo" },
      projects: { demo: {} },
      ownerOpenIdsByProfile: { owner: ["ou_admin"] },
    },
    store: {
      read: async () => structuredClone(state),
      transact: async (fn) => fn(state),
    },
  };
  return {
    context,
    state,
    turn,
    admin: { ...turn, id: "approval", senderId: "ou_admin" },
  };
}
test("enrollment rejects credential URLs and unsupported sites before any launch", () => {
  for (const url of [
    "http://user:password@example.test/nacos",
    "http://example.test/other",
    "file:///nacos",
    "http://example.test/nacos?token=hidden",
  ])
    assert.throws(() => enrollmentTarget({ kind: "nacos", tier: "prd", url }));
  assert.equal(
    enrollmentTarget({
      kind: "nacos",
      tier: "prd",
      url: "http://example.test/nacos/#/login",
    }).url,
    "http://example.test/nacos",
  );
  assert.throws(() =>
    enrollmentTarget({
      kind: "mysql",
      tier: "prd",
      url: "mysql://user:secret@db.test/demo",
    }),
  );
});
test("member request never opens browser; approval requires exact thread and admin and is single launch", async (t) => {
  const { context, state, turn, admin } = await fixture(t);
  await requestEnrollment(context, turn);
  let opened = 0;
  const launch = async () => {
    opened++;
  };
  await assert.rejects(approveEnrollment(context, turn, launch));
  await assert.rejects(
    approveEnrollment(context, { ...admin, questionId: "other" }, launch),
  );
  assert.equal(opened, 0);
  await approveEnrollment(context, admin, launch);
  await assert.rejects(approveEnrollment(context, admin, launch));
  assert.equal(opened, 1);
  assert.equal(
    Object.values(state.environmentEnrollments)[0].status,
    "opening",
  );
});
test("successful local setup resumes original member once and retains PRD query approval", async (t) => {
  const { context, state, turn, admin } = await fixture(t);
  await requestEnrollment(context, turn);
  await approveEnrollment(context, admin, async () => {});
  const e = Object.values(state.environmentEnrollments)[0];
  const dir = path.join(
    context.config.dataDir,
    "environment-enrollments",
    e.id,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ status: "login_required" }),
  );
  await pollEnrollments(context);
  assert.match(turn.response, /已在运行AgentOS/);
  turn.status = "sent";
  const cfg = {
    environments: {
      [e.id.toLowerCase()]: {
        kind: "nacos",
        tier: "prd",
        projectId: "demo",
        membersRead: false,
        ownerOpenIdsByProfile: { owner: ["ou_admin"] },
        queries: {
          investigate: {
            mode: "investigate",
            reviewed: true,
            description: "test",
            namespaces: ["prd"],
            maxCalls: 8,
            maxRows: 20,
            timeoutMs: 5000,
            parameters: [{ name: "purpose", type: "string" }],
          },
        },
      },
    },
  };
  await writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ status: "complete" }),
  );
  await pollEnrollments(context, async () => cfg);
  assert.equal(turn.senderId, "ou_member");
  assert.equal(turn.status, "decided");
  assert.ok(turn.environmentResumeKey);
  assert.equal(turn.decision.action, "create_task");
  const plan = planQuery(cfg, turn.decision.environmentQuery, "demo", turn);
  assert.equal(plan.approvalRequired, true);
  const snapshot = JSON.stringify(state);
  await pollEnrollments(context, async () => cfg);
  assert.equal(JSON.stringify(state), snapshot);
});
test("launch failure and expired enrollment cannot claim login or continue querying", async (t) => {
  const { context, state, turn, admin } = await fixture(t);
  await requestEnrollment(context, turn);
  await assert.rejects(
    approveEnrollment(context, admin, async () => {
      throw new Error("desktop unavailable");
    }),
  );
  assert.equal(Object.values(state.environmentEnrollments)[0].status, "failed");
  const e = Object.values(state.environmentEnrollments)[0];
  e.status = "requested";
  e.createdAt = "2000-01-01";
  await pollEnrollments(context);
  assert.equal(e.status, "expired");
  assert.notEqual(turn.decision.action, "create_task");
});

import { attachQuestion } from '../src/control-plane/questions.js';
test('exact approval-card reply takes priority over newer cards sharing a topic root',()=>{
 const state={questions:{first:{id:'first',messageId:'root',threadRootId:'root',chatId:'g',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'one',generation:1},second:{id:'second',messageId:'follow',threadRootId:'root',chatId:'g',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'two',generation:1}},conversations:[{id:'one',status:'sent'},{id:'two',status:'sent'}],jobs:[{id:'j1',questionId:'first',status:'awaiting_environment_approval'},{id:'j2',questionId:'second',status:'running'}],cardMessages:{'question:first':{messageId:'card1'},'question:second':{messageId:'card2'}}};
 const turn={id:'approve',chatId:'g',profile:'owner',projectId:'p',senderId:'ou_admin',content:'同意',messageId:'new'};
 attachQuestion(state,turn,{reply_to:'card1',root_id:'root'},{ownerOpenIdsByProfile:{owner:['ou_admin']}});assert.equal(turn.questionId,'first');
});

test('database discovery continues once into enrollment without opening a window or borrowing authority', async t=>{
 const {context,state,turn}=await fixture(t);
 turn.decision={...turn.decision,action:'create_task',environmentSetup:{kind:'mysql',tier:'prd',url:''}};
 const evidence={scopeHash:'scope',readAt:new Date().toISOString()};
 state.jobs.push({id:'discovery',sourceMessageId:turn.id,questionId:'q',chatId:'group',projectId:'demo',originProfile:'owner',status:'completed',updatedAt:new Date().toISOString(),environmentAccess:{tier:'prd',startedAt:new Date().toISOString(),scopeHash:'scope'},result:{outcome:'partial',environmentEvidence:evidence,connectionEndpoints:[{host:'db.example.test',port:3306,database:'app',connectionSource:{namespace:'prd',group:'g',dataId:'d',contentHash:'a'.repeat(64)},password:'never-copy'}]}});
 await pollEnrollments(context);
 const requests=Object.values(state.environmentEnrollments);assert.equal(requests.length,1);assert.equal(requests[0].url,'mysql://db.example.test:3306/app');assert.equal(requests[0].senderId,'ou_member');assert.equal(requests[0].status,'requested');
 assert.equal(state.jobs[0].connectionEnrollmentHandled,true);assert.match(turn.response,/管理员/);assert.doesNotMatch(JSON.stringify(requests),/never-copy/);
 await pollEnrollments(context);assert.equal(Object.keys(state.environmentEnrollments).length,1);
});

test('unsupported TLS produces pending scoped confirmation, never automatic downgrade',async t=>{
 const {context,state,turn,admin}=await fixture(t);await requestEnrollment(context,turn);const e=Object.values(state.environmentEnrollments)[0];e.databaseSource={synthetic:true};
 const first=await approveEnrollment(context,admin,async()=>{throw Object.assign(new Error('Server does not support secure connection'),{code:'HANDSHAKE_NO_SSL_SUPPORT'});});
 assert.equal(e.status,'awaiting_tls_confirmation');assert.equal(e.tlsException,undefined);assert.match(first.notice,/回复本卡“同意”/);
 for(const content of ['不同意本目标使用非TLS'])await assert.rejects(approveEnrollment(context,{...admin,content,decision:{action:'approve_environment_without_tls'}},async()=>{}));
 await assert.rejects(approveEnrollment(context,{...turn,content:'同意本目标使用非TLS',decision:{action:'approve_environment_without_tls'}},async()=>{}),/管理员/);
 let calls=0;await approveEnrollment(context,{...admin,content:'同意',decision:{action:'approve_environment_without_tls'}},async value=>{});
 assert.equal(e.tlsException.url,e.url);assert.equal(e.tlsException.approverId,admin.senderId);
 await assert.rejects(approveEnrollment(context,{...admin,content:'同意本目标使用非TLS',decision:{action:'approve_environment_without_tls'}},async()=>{calls++;}));assert.equal(calls,0);
});
