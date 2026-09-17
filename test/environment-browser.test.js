import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createNacosBrowser } from "../src/runner/environment-browser.js";
import {
  browserRequestPolicy,
  filterNacosResponse,
} from "../src/runner/nacos-browser-policy.js";
import { validateToolQuery } from "../src/shared/environment-tool-policy.js";
import {
  planQuery,
  verifyApprovedPlan,
} from "../src/shared/environment-access.js";
const root = "http://localhost:8848/nacos";
const q = {
  mode: "investigate",
  browser: true,
  namespaces: ["test"],
  parameters: [{ name: "purpose", type: "string" }],
  maxCalls: 10,
  maxRows: 20,
  timeoutMs: 5000,
};
test("browser gate rejects write GETs, methods, foreign origins and ambiguous scopes", () => {
  const policy = (path, method = "GET", login = false) =>
    browserRequestPolicy(
      root,
      ["test"],
      { url: "http://localhost:8848" + path, method },
      login,
    );
  for (const method of ["POST", "DELETE", "PATCH", "PUT", "HEAD"])
    assert.equal(policy("/nacos/v1/cs/configs?tenant=test", method), "deny");
  for (const path of [
    "/nacos/v1/cs/configs?tenant=prd",
    "/nacos/v1/cs/configs?tenant=test&delete=true",
    "/nacos/v1/cs/configs?tenant=test&tenant=prd",
    "/nacos/v1/cs/configs?tenant=test&namespace=prd",
    "/nacos/v1/cs/configs?tenant=test&show=delete",
    "/nacos/v1/auth/users",
    "/nacos/v1/cs/configs?tenant=test&pageSize=999",
  ])
    assert.equal(policy(path), "deny");
  assert.equal(
    browserRequestPolicy(root, ["test"], {
      url: "http://elsewhere/nacos/",
      method: "GET",
    }),
    "deny",
  );
  assert.equal(policy("/nacos/v1/auth/login", "POST", false), "deny");
  assert.equal(policy("/nacos/v1/auth/login", "POST", true), "login");
  assert.equal(
    policy(
      "/nacos/v1/cs/configs?tenant=test&dataId=db.yaml&group=DEFAULT_GROUP",
    ),
    "config",
  );
});
test("response filtering hides original secrets and unauthorized namespaces", () => {
  const observations = [];
  const body = JSON.stringify({
    pageItems: [
      {
        dataId: "db.yaml",
        group: "DEFAULT_GROUP",
        content: "url: jdbc:mysql://db.example/demo\npassword: secret-test",
        encryptedDataKey: "secret-key",
      },
    ],
    totalCount: 1,
  });
  const value = filterNacosResponse(
    "/nacos/v1/cs/configs",
    body,
    ["test"],
    observations,
  );
  assert.doesNotMatch(value, /secret-test|secret-key/);
  assert.match(value, /db.example/);
  assert.equal(observations[0].rows.length, 1);
  const ns = filterNacosResponse(
    "/nacos/v1/console/namespaces",
    JSON.stringify({
      data: [
        { namespace: "test", namespaceShowName: "Testing" },
        { namespace: "prod", namespaceShowName: "Production" },
      ],
    }),
    ["test"],
    [],
  );
  assert.doesNotMatch(ns, /Production|prod/);
});
test("browser enablement rejects other connector kinds and invalidates earlier approval", () => {
  assert.throws(() => validateToolQuery({ kind: "mysql" }, q));
  assert.throws(() =>
    validateToolQuery({ kind: "nacos" }, { ...q, browser: "true" }),
  );
  const e = {
    kind: "nacos",
    tier: "prd",
    projectId: "demo",
    membersRead: false,
    ownerOpenIdsByProfile: { owner: ["ou_admin"] },
    queries: { investigate: { ...q, browser: false, description: "test" } },
  };
  const cfg = { environments: { env: e } };
  const p = planQuery(
    cfg,
    { environmentId: "env", queryId: "investigate", parameters: ["view"] },
    "demo",
    { profile: "owner", senderId: "ou_admin" },
  );
  e.queries.investigate.browser = true;
  assert.throws(() => verifyApprovedPlan(cfg, p));
});
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="view"></main><script>
let logged=sessionStorage.logged==='yes';
async function render(){if(!logged){view.innerHTML='<input type="text" placeholder="用户名"><input type="password"><button id="login">登录</button>';document.getElementById('login').onclick=async()=>{const r=await fetch('/nacos/v1/auth/login',{method:'POST',body:new URLSearchParams({username:document.querySelector('input').value,password:document.querySelector('input[type=password]').value})});if(r.ok){logged=true;sessionStorage.logged='yes';location.hash='/configurationManagement?namespace=test';await render();}};return;}
view.innerHTML='<h1>配置列表</h1><input placeholder="Data ID"><button id="query">查询</button><button id="detail">详情</button><button id="delete">删除</button><pre id="content"></pre>';
document.getElementById('query').onclick=async()=>{const r=await fetch('/nacos/v1/cs/configs?tenant=test&search=blur&pageSize=10');document.getElementById('content').textContent=await r.text();};
document.getElementById('detail').onclick=async()=>{const r=await fetch('/nacos/v1/cs/configs?tenant=test&dataId=db.yaml&group=DEFAULT_GROUP');document.getElementById('content').textContent=await r.text();};
document.getElementById('delete').onclick=()=>fetch('/nacos/v1/cs/configs?tenant=test',{method:'DELETE'});
}render();</script></body></html>`;
async function fixture(t) {
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/nacos/v1/auth/login" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      res.end('{"accessToken":"fixture-token"}');
      return;
    }
    if (req.method !== "GET" || req.url.includes("delete=true")) {
      writes++;
      res.end("unexpected-write");
      return;
    }
    if (req.url.startsWith("/nacos/v1/cs/configs")) {
      res.setHeader("content-type", "text/plain");
      res.end(
        "url: jdbc:mysql://fixture-db/demo\npassword: hidden-fixture-secret",
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/nacos`,
    writes: () => writes,
  };
}
test("real Chromium read controls work while actual write requests never reach the server", async (t) => {
  const f = await fixture(t);
  let page;
  const tools = await createNacosBrowser(
    { baseUrl: f.baseUrl },
    q,
    { username: "fixture-user", password: "fixture-password" },
    {
      onPage: (p) => {
        page = p;
      },
    },
  );
  t.after(() => tools.close());
  const opened = await tools.run("browser_open");
  assert.doesNotMatch(JSON.stringify(opened), /fixture-password|fixture-token/);
  assert.ok(opened.controls.some((x) => x.label === "详情"));
  assert.ok(!opened.controls.some((x) => x.label === "删除"));
  await page.evaluate(async () => {
    await Promise.allSettled([
      fetch("/nacos/v1/cs/configs?tenant=test", { method: "DELETE" }),
      fetch("/nacos/v1/cs/configs?tenant=test&delete=true"),
      fetch("/nacos/v1/cs/configs?tenant=prd"),
    ]);
  });
  assert.equal(f.writes(), 0);
  const result = await tools.run("browser_click", {
    ref: opened.controls.find((x) => x.label === "详情").ref,
  });
  assert.equal(result.rows[0].database, "demo");
  assert.doesNotMatch(
    JSON.stringify(result),
    /hidden-fixture-secret|fixture-password/,
  );
  assert.ok(result.blockedRequests >= 3);
  await assert.rejects(
    tools.run("browser_click", {
      ref: opened.controls.find((x) => x.label === "详情").ref,
    }),
  );
});

test("local browser login captures only successful credentials without querying configuration", async (t) => {
  const f = await fixture(t);
  const cred = {};
  let page;
  const tools = await createNacosBrowser(
    { baseUrl: f.baseUrl },
    { ...q, namespaces: [] },
    cred,
    {
      manualLogin: true,
      chromium: {
        launch: async (options) =>
          (await import("playwright")).chromium.launch({
            ...options,
            headless: true,
          }),
      },
      onPage: (p) => {
        page = p;
      },
    },
  );
  t.after(() => tools.close());
  const result = tools.run("browser_open");
  while (!page) await new Promise((r) => setTimeout(r, 20));
  await page.locator("input[type=password]").waitFor();
  await page.locator("input[type=text]").fill("local-user");
  await page.locator("input[type=password]").fill("local-password");
  await page.locator("#login").click();
  assert.match((await result).stage, /已验证/);
  assert.equal(cred.username, "local-user");
  assert.equal(cred.password, "local-password");
  assert.equal(f.writes(), 0);
});

test('reopening authenticated browser reuses current page and refreshes controls without another login', async t => {
  const f = await fixture(t); let page;
  const tools = await createNacosBrowser({baseUrl:f.baseUrl},q,{username:'fixture-user',password:'fixture-password'},{onPage:p=>{page=p;}});
  t.after(()=>tools.close());
  const first = await tools.run('browser_open');
  const url = page.url(); let navigations=0;
  page.on('framenavigated',()=>navigations++);
  const reopened = await tools.run('browser_open');
  assert.equal(page.url(),url); assert.equal(navigations,0);
  assert.ok(reopened.controls.some(x=>x.label==='详情'));
  assert.notEqual(first.controls.find(x=>x.label==='详情').ref,reopened.controls.find(x=>x.label==='详情').ref);
  const result=await tools.run('browser_click',{ref:reopened.controls.find(x=>x.label==='详情').ref});
  assert.equal(result.rows[0].database,'demo');
  await page.evaluate(()=>{document.body.innerHTML='<input type="password">';});
  await assert.rejects(tools.run('browser_open'),error=>error.diagnosticStage==='browser.reuse-session' && /AUTH_REQUIRED/.test(error.message));
});
