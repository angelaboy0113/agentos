import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkbench, safeFile } from "../server.js";
import { Notifications } from "../notifications.js";
import { Auth } from "../auth.js";
import { WorkbenchStore } from "../store.js";
import { loadConfig } from "../config.js";
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-test-"));
  const config = {
    mode: "preview",
    publicUrl: "http://127.0.0.1:8790",
    dataDir: dir,
    ownerIds: ["preview-owner"],
    allowedProjectIds: ["tpm"],
    notifications: { enabled: false },
    ...extra,
  };
  const app = await createWorkbench(config, {
    sendNotification: async () => {},
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const call = async (url, method = "GET", data, session = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: {
        origin: config.publicUrl,
        ...(session.cookie ? { cookie: session.cookie } : {}),
        ...(session.csrf ? { "x-csrf-token": session.csrf } : {}),
        ...(data !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    let body;
    try {
      body = await r.json();
    } catch {}
    return { status: r.status, body, headers: r.headers };
  };
  const login = async (id) => {
    const r = await call("/api/preview-login", "POST", { id });
    const cookie = r.headers.get("set-cookie").split(";")[0];
    const info = await call("/api/me", "GET", undefined, { cookie });
    return { cookie, csrf: info.body.csrf };
  };
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, dir, config, call, login, base };
}
test("private topic list, direct read and files isolate peers; owner can audit all; invite then revoke", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague"),
    b = await f.login("preview-other"),
    owner = await f.login("preview-owner");
  const made = await f.call("/api/topics", "POST", { projectId: "tpm" }, a),
    id = made.body.topic.id;
  assert.equal(made.status, 201);
  assert.equal(
    (await f.call("/api/topics/" + id, "GET", undefined, b)).status,
    404,
  );
  assert.equal(
    (await f.call("/api/topics?scope=all", "GET", undefined, b)).status,
    403,
  );
  assert.equal(
    (await f.call("/api/topics?scope=all", "GET", undefined, owner)).body.topics
      .length,
    1,
  );
  assert.equal(
    (await f.call("/api/files", "GET", undefined, b)).body.files.length,
    0,
  );
  await f.call(
    "/api/topics/" + id + "/members",
    "POST",
    { userId: "preview-other" },
    a,
  );
  assert.equal(
    (await f.call("/api/topics/" + id, "GET", undefined, b)).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/api/topics/" + id + "/members",
        "POST",
        { userId: "preview-owner" },
        b,
      )
    ).status,
    403,
  );
  await f.call(
    "/api/topics/" + id + "/members/preview-other",
    "DELETE",
    undefined,
    a,
  );
  assert.equal(
    (await f.call("/api/topics/" + id, "GET", undefined, b)).status,
    404,
  );
});
test("messages deduplicate across retries; typed mentions do not grant; CSRF required", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague");
  const id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id,
    b = { text: "@陈远 please inspect", requestId: randomUUID() };
  assert.equal(
    (
      await f.call("/api/topics/" + id + "/messages", "POST", b, {
        cookie: a.cookie,
      })
    ).status,
    403,
  );
  await Promise.all([
    f.call("/api/topics/" + id + "/messages", "POST", b, a),
    f.call("/api/topics/" + id + "/messages", "POST", b, a),
  ]);
  const s = await f.app.store.read();
  assert.equal(
    s.topics[id].messages.filter((m) => m.kind === "user").length,
    1,
  );
  assert.deepEqual(s.topics[id].members, []);
});
test("raw attachment streams, unauthorized download denied and no paths exposed", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague"),
    b = await f.login("preview-other"),
    id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id;
  const r = await fetch(f.base + "/api/topics/" + id + "/files", {
    method: "POST",
    headers: {
      origin: f.config.publicUrl,
      cookie: a.cookie,
      "x-csrf-token": a.csrf,
      "x-file-name": encodeURIComponent("年度说明.txt"),
    },
    body: "file contents",
  });
  assert.equal(r.status, 201);
  const file = (await r.json()).file;
  const v = await f.call("/api/topics/" + id, "GET", undefined, a);
  assert(!JSON.stringify(v.body).includes(f.dir));
  assert.equal(
    (
      await f.call(
        "/api/topics/" + id + "/files/" + file.id,
        "GET",
        undefined,
        b,
      )
    ).status,
    404,
  );
  const downloaded = await fetch(
    f.base + "/api/topics/" + id + "/files/" + file.id,
    { headers: { cookie: a.cookie } },
  );
  assert.equal(await downloaded.text(), "file contents");
});
test("notification failure retries fixed event without duplicate AI and suppresses revoked access", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    notifications: { enabled: true },
    sendNotification: undefined,
  });
  const a = await f.login("preview-colleague"),
    id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id;
  await f.call(
    "/api/topics/" + id + "/messages",
    "POST",
    { text: "hello", requestId: randomUUID() },
    a,
  );
  const n = new Notifications(f.app.store, f.config, async (e, text) => {
    sent.push({ id: e.id, text });
    if (sent.length === 1) throw Error("offline");
  });
  await n.tick();
  await f.app.store.tx((s) => {
    for (const e of Object.values(s.outbox)) e.retryAt = 0;
  });
  await n.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].id, sent[1].id);
  assert(!sent[1].text.includes("hello"));
  assert(sent[1].text.includes("/?topic=" + id));
  const state = await f.app.store.read();
  assert.equal(
    state.topics[id].messages.filter((m) => m.kind === "user").length,
    1,
  );
});
test("filesystem boundaries reject traversal and symlinks", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "root"));
  await writeFile(path.join(dir, "outside"), "secret");
  await symlink(path.join(dir, "outside"), path.join(dir, "root", "link"));
  await assert.rejects(
    safeFile(path.join(dir, "root"), path.join(dir, "outside")),
  );
  await assert.rejects(
    safeFile(path.join(dir, "root"), path.join(dir, "root", "link")),
  );
  await writeFile(path.join(dir, "root", "valid"), "ok");
  assert.equal(
    (await safeFile(path.join(dir, "root"), path.join(dir, "root", "valid")))
      .bytes,
    2,
  );
});
test("single owner lock and persistent topics survive restart", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await new WorkbenchStore(dir).start();
  await s.tx((x) => {
    x.topics.test = { title: "retained" };
  });
  await assert.rejects(new WorkbenchStore(dir).start(), /already owned/);
  await s.close();
  const next = await new WorkbenchStore(dir).start();
  assert.equal((await next.read()).topics.test.title, "retained");
  await next.close();
});
test("OAuth callback rejects state replay and other tenants, never trusts request actor", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-oauth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await new WorkbenchStore(dir).start(),
    config = {
      mode: "live",
      publicUrl: "https://work.example",
      sessionSecret: "s".repeat(32),
      feishu: { appId: "app", appSecret: "secret", tenantKey: "company" },
    };
  const auth = new Auth(s, config, {
    fetcher: async (url) => ({
      json: async () =>
        url.endsWith("/token")
          ? { access_token: "not-persisted" }
          : {
              code: 0,
              data: { open_id: "someone", name: "X", tenant_key: "other" },
            },
    }),
  });
  let cookie;
  const res = { setHeader: (k, v) => (cookie = v) };
  const url = new URL(auth.start(res)),
    state = url.searchParams.get("state");
  const req = { headers: { cookie: cookie.split(";")[0] } };
  await assert.rejects(
    auth.callback(
      req,
      new URL("https://work.example/auth/callback?state=" + state + "&code=x"),
      res,
    ),
    /本企业/,
  );
  await assert.rejects(
    auth.callback(
      req,
      new URL("https://work.example/auth/callback?state=" + state + "&code=x"),
      res,
    ),
    /失效/,
  );
  assert.deepEqual((await s.read()).users, {});
  auth.fetcher = async (url) => ({
    json: async () =>
      url.endsWith("/token")
        ? { access_token: "private-test-token" }
        : {
            code: 0,
            data: {
              open_id: "ou_testUser",
              name: "Member",
              tenant_key: "company",
            },
          },
  });
  const next = new URL(auth.start(res)),
    validState = next.searchParams.get("state"),
    validReq = { headers: { cookie: cookie.split(";")[0] } };
  await auth.callback(
    validReq,
    new URL(
      "https://work.example/auth/callback?state=" + validState + "&code=ok",
    ),
    res,
  );
  assert(cookie.includes("Secure"));
  assert(cookie.includes("HttpOnly"));
  assert(!JSON.stringify(await s.read()).includes("private-test-token"));
  assert.equal(
    (await auth.actor({ headers: { cookie: cookie.split(";")[0] } })).id,
    "ou_testUser",
  );
  await s.close();
});
test("configuration rejects public preview and insecure live configuration", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify({ mode: "preview", host: "0.0.0.0" }));
  await assert.rejects(loadConfig(file), /loopback/);
  await writeFile(file, JSON.stringify({ mode: "live" }));
  await assert.rejects(loadConfig(file), /HTTPS/);
});
test("late completion and backend dispatch recovery do not report success before acceptance", async (t) => {
  let accepts = 0;
  const f = await fixture(t);
  f.app.adapter.submit = async () => {
    accepts++;
    if (accepts === 1) throw Error("offline");
  };
  const a = await f.login("preview-colleague"),
    id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id;
  await f.call(
    "/api/topics/" + id + "/messages",
    "POST",
    { text: "recover", requestId: randomUUID() },
    a,
  );
  await f.app.sync();
  let s = await f.app.store.read();
  if (s.topics[id].messages[0].dispatch !== "sent") await f.app.sync();
  s = await f.app.store.read();
  assert.equal(s.topics[id].messages[0].dispatch, "sent");
  assert(accepts >= 2);
  assert.equal(
    s.topics[id].messages.filter((m) => m.kind === "user").length,
    1,
  );
});
test("notifications are suppressed after membership revoke", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague"),
    id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id;
  await f.app.store.tx((s) => {
    s.outbox.test = {
      id: "notice",
      topicId: id,
      recipient: "preview-other",
      kind: "mention",
      status: "pending",
      attempts: 0,
    };
  });
  let sent = 0;
  const n = new Notifications(
    f.app.store,
    { ...f.config, notifications: { enabled: true } },
    async () => sent++,
  );
  await n.tick();
  assert.equal(sent, 0);
  assert.equal((await f.app.store.read()).outbox.test.status, "revoked");
});
test("30-day cleanup protects pending/active records and leaves unknown files", async (t) => {
  const { pruneWorkbench } = await import("../retention.js");
  const f = await fixture(t),
    old = new Date(Date.now() - 31 * 86400000).toISOString();
  await f.app.store.tx((s) => {
    for (const [id, status] of [
      ["old", "completed"],
      ["active", "running"],
      ["pending", "completed"],
    ])
      s.topics[id] = { id, status, updatedAt: old, messages: [], uploads: [] };
    s.outbox.pending = { topicId: "pending", status: "pending" };
  });
  const result = await pruneWorkbench(f.app.store, f.config);
  assert.equal(result.topics, 1);
  const s = await f.app.store.read();
  assert(!s.topics.old);
  assert(s.topics.active);
  assert(s.topics.pending);
});
test("upload larger than 5MB has no artificial rejection and retains original bytes", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague"),
    id = (await f.call("/api/topics", "POST", { projectId: "tpm" }, a)).body
      .topic.id,
    data = Buffer.alloc(6 * 1024 * 1024, 7);
  const r = await fetch(f.base + "/api/topics/" + id + "/files", {
    method: "POST",
    headers: {
      origin: f.config.publicUrl,
      cookie: a.cookie,
      "x-csrf-token": a.csrf,
      "x-file-name": "large.bin",
    },
    body: data,
  });
  assert.equal(r.status, 201);
  const file = (await r.json()).file;
  assert.equal(file.bytes, data.length);
  const out = await fetch(f.base + "/api/topics/" + id + "/files/" + file.id, {
    headers: { cookie: a.cookie },
  });
  assert(Buffer.from(await out.arrayBuffer()).equals(data));
});
test("client actor and owner claims cannot elevate a member, secrets are not persisted as chat", async (t) => {
  const f = await fixture(t),
    a = await f.login("preview-colleague"),
    r = await f.call(
      "/api/topics",
      "POST",
      { projectId: "tpm", ownerId: "preview-owner" },
      a,
    ),
    id = r.body.topic.id;
  assert.equal(r.body.topic.ownerId, "preview-colleague");
  const sent = await f.call(
    "/api/topics/" + id + "/messages",
    "POST",
    {
      text: "账号: demo 密码: secret",
      requestId: randomUUID(),
      senderId: "preview-owner",
    },
    a,
  );
  assert.equal(sent.status, 400);
  assert.equal((await f.app.store.read()).topics[id].messages.length, 0);
});
