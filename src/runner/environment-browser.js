import { chromium } from "playwright";
import {
  browserRequestPolicy,
  filterNacosResponse,
  unsafeControl,
} from "./nacos-browser-policy.js";
export async function createNacosBrowser(e, q, cred, adapters = {}) {
  let browser,
    context,
    page,
    active = true,
    loggingIn = false,
    loggedIn = false,
    generation = 0;
  const refs = new Map(),
    observations = [],
    tokens = [];
  const manual = adapters.manualLogin === true;
  let loginResolve;
  const loginReady = new Promise((resolve) => {
    loginResolve = resolve;
  });
  let blocked = 0,
    calls = 0,
    phase = "initializing";
  const clean = (s) => {
    s = String(s ?? "");
    for (const secret of [cred.username, cred.password, ...tokens].filter(
      Boolean,
    ))
      s = s.split(secret).join("[已隐藏]");
    return s
      .replace(
        /(?:password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi,
        "[敏感字段已隐藏]",
      )
      .slice(0, 10000);
  };
  async function close() {
    active = false;
    refs.clear();
    try {
      await context?.close();
    } finally {
      await browser?.close();
    }
  }
  async function ensure() {
    if (!active) throw new Error("浏览器任务已结束");
    if (page) return;
    browser = await (adapters.chromium ?? chromium).launch({
      headless: !manual,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    if (!active) {
      await browser.close();
      throw new Error("Browser closed");
    }
    context = await browser.newContext({
      locale: "zh-CN",
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
      for (const key of [
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebTransport",
      ])
        Object.defineProperty(window, key, {
          value: undefined,
          configurable: false,
        });
    });
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      const decision = browserRequestPolicy(
        e.baseUrl,
        q.namespaces,
        { url: req.url(), method: req.method() },
        loggingIn,
      );
      if (!active || decision === "deny") {
        blocked++;
        await adapters.onBlocked?.({
          path: url.pathname,
          method: req.method(),
          keys: [...url.searchParams.keys()],
          scopeMatches: q.namespaces.includes(
            url.searchParams.get("tenant") ?? "",
          ),
        });
        await route.abort().catch(() => {});
        return;
      }
      try {
        if (decision === "login") {
          const body = new URLSearchParams(req.postData() ?? "");
          if (manual) {
            if (
              !body.get("username") ||
              !body.get("password") ||
              req.postData().length > 16000
            )
              throw new Error("Invalid login");
            cred.username = body.get("username");
            cred.password = body.get("password");
          } else if (
            body.get("username") !== cred.username ||
            body.get("password") !== cred.password
          )
            throw new Error("Unapproved login");
        }
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: q.timeoutMs,
        });
        if (response.status() >= 300 && response.status() < 400)
          throw new Error("Redirect blocked");
        const length = Number(response.headers()["content-length"] ?? 0);
        if (length > (decision === "asset" ? 12 : 1) * 1024 * 1024)
          throw new Error("Response limit");
        if (decision === "asset") {
          await route.fulfill({ response });
          return;
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 1024 * 1024)
          throw new Error("Response limit");
        if (decision === "login") {
          const value = JSON.parse(raw);
          loggedIn =
            response.ok() &&
            typeof value.accessToken === "string" &&
            !!value.accessToken;
          if (loggedIn) tokens.push(value.accessToken);
          await route.fulfill({ response });
          if (loggedIn) loginResolve();
          return;
        }
        if (!response.ok()) throw new Error("Read failed");
        const body = filterNacosResponse(
          url.pathname,
          raw,
          q.namespaces,
          observations,
        );
        await route.fulfill({
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "application/json",
          body,
        });
      } catch {
        blocked++;
        await route
          .fulfill({
            status: 403,
            contentType: "application/json",
            body: '{"code":403,"message":"AgentOS blocked unsupported or out-of-scope request"}',
          })
          .catch(() => {});
      }
    });
    page = await context.newPage();
    page.on("download", (d) => d.cancel().catch(() => {}));
    page.on("popup", (p) => p.close().catch(() => {}));
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await adapters.onPage?.(page);
    page.setDefaultTimeout(q.timeoutMs);
  }
  async function settle() {
    await page
      .waitForLoadState("networkidle", { timeout: q.timeoutMs })
      .catch(() => {});
  }
  async function snapshot() {
    generation++;
    refs.clear();
    // Configuration API bodies are filtered before they reach the DOM. Inputs/editor bodies are excluded too.
    const text = await page.locator("body").evaluate((body) => {
      const clone = body.cloneNode(true);
      clone
        .querySelectorAll(
          "script,style,input,textarea,pre,code,.CodeMirror,.monaco-editor,[contenteditable]",
        )
        .forEach((x) => x.remove());
      return clone.innerText || clone.textContent || "";
    });
    const candidates = page.locator(
      'button,a,[role="button"],input:not([type="password"]):not([type="hidden"])',
    );
    const controls = [];
    for (let i = 0, n = Math.min(await candidates.count(), 120); i < n; i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible()) || !(await el.isEnabled())) continue;
      const tag = await el.evaluate((x) => x.tagName.toLowerCase());
      const label = clean(
        (await el.innerText().catch(() => "")) ||
          (await el.getAttribute("placeholder")) ||
          (await el.getAttribute("aria-label")) ||
          "",
      )
        .trim()
        .slice(0, 100);
      if (!label || unsafeControl.test(label)) continue;
      if (
        tag === "input" &&
        !/data\s?id|group|搜索|查询|模糊|search/i.test(label)
      )
        continue;
      const ref = `${generation}-${controls.length + 1}`;
      refs.set(ref, { el, tag });
      const row = await el.evaluate(
        (x) => x.closest('tr,[role="row"],.next-table-row')?.innerText ?? "",
      );
      controls.push({
        ref,
        type: tag === "input" ? "search" : "read-action",
        label,
        context: clean(row).slice(0, 350),
      });
    }
    const rows = [
      ...new Map(
        observations.flatMap((x) => x.rows).map((x) => [JSON.stringify(x), x]),
      ).values(),
    ].slice(0, q.maxRows);
    return {
      stage: "已读取隔离浏览器页面",
      pageText: clean(text).slice(0, 5000),
      controls,
      rows,
      blockedRequests: blocked,
      configViews: observations.length,
      partial: observations.length > 0 && rows.length === 0,
      note: "页面来自实际Nacos控制台；配置正文已过滤。未连接数据库。",
    };
  }
  async function perform(tool, args = {}) {
    if (!active || ++calls > q.maxCalls)
      throw new Error("浏览器调用已结束或超过次数限制");
    try {
      phase = "launch";
      await ensure();
      if (tool === "browser_open") {
        phase = "open-login";
        loggingIn = true;
        await page.goto(e.baseUrl.replace(/\/$/, "") + "/#/login", {
          waitUntil: "domcontentloaded",
        });
        phase = "login-form";
        const password = page.locator('input[type="password"]');
        await password.first().waitFor({ state: "visible" });
        if (manual) {
          await adapters.onLoginReady?.();
          let timer;
          try {
            await Promise.race([
              loginReady,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Local login timeout")),
                  300000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        } else {
          const username = page
            .locator('input[type="text"],input:not([type])')
            .first();
          await username.fill(cred.username);
          await password.first().fill(cred.password);
          phase = "login-submit";
          const login = page
            .locator("button")
            .filter({ hasText: /登录|提交|Log in|Sign in|Submit/i })
            .first();
          await login.click();
          await settle();
        }
        loggingIn = false;
        phase = "login-result";
        if (!loggedIn) throw new Error("Login required");
        if (manual) return { stage: "本机独立浏览器登录已验证" };
        const url =
          e.baseUrl.replace(/\/$/, "") +
          "/#/configurationManagement?namespace=" +
          encodeURIComponent(q.namespaces[0]);
        phase = "open-config";
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await settle();
        return await snapshot();
      }
      if (!loggedIn) throw new Error("先执行browser_open");
      if (tool === "browser_snapshot") return await snapshot();
      const target = refs.get(args.ref);
      if (!target) throw new Error("页面引用已失效，请重新获取页面");
      if (tool === "browser_click") {
        if (target.tag === "input") throw new Error("Not clickable");
        const label = await target.el.innerText();
        if (unsafeControl.test(label)) throw new Error("Write control");
        await target.el.click();
        refs.clear();
        await settle();
        return await snapshot();
      }
      if (tool === "browser_search") {
        if (
          target.tag !== "input" ||
          typeof args.text !== "string" ||
          args.text.length > 100 ||
          /[\x00-\x1f]/.test(args.text)
        )
          throw new Error("Invalid search");
        await target.el.fill(args.text);
        return await snapshot();
      }
      throw new Error("Unknown browser tool");
    } catch (error) {
      await adapters.onError?.({ phase, name: error.name, blocked });
      loggingIn = false;
      await close();
      throw new Error(
        "浏览器只读操作未完成：阶段：" +
          phase +
          "；可能需要本机重新登录、页面版本不支持、引用失效或请求超出范围。未放开写入或其他网址。",
      );
    }
  }
  async function run(tool, args = {}) {
    let timer;
    try {
      return await Promise.race([
        perform(tool, args),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              void close().catch(() => {});
              reject(new Error("浏览器操作超时，已关闭独立会话"));
            },
            manual ? 310000 : 30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    spec: [
      {
        tool: "browser_open",
        args: {},
        description:
          "打开当前已授权Nacos的实际网页，使用本机凭据自动登录；返回脱敏页面和操作引用",
      },
      {
        tool: "browser_snapshot",
        args: {},
        description: "查看当前页面，重新取得有效操作引用",
      },
      {
        tool: "browser_click",
        args: { ref: "当前页面的read-action引用" },
        description:
          "点击详情、查询、翻页等只读页面控件；发布删除等写请求被程序阻断",
      },
      {
        tool: "browser_search",
        args: { ref: "当前页面的search引用", text: "搜索词" },
        description: "填写Data ID或Group查询输入框，然后点击页面查询控件",
      },
    ],
    run,
    close,
  };
}

// Local setup only: capture successful form credentials into memory, never send them to the model.
export async function loginNacosLocally(baseUrl, options = {}) {
  const cred = {};
  const b = await createNacosBrowser(
    { baseUrl },
    { namespaces: [], maxCalls: 1, maxRows: 1, timeoutMs: 10000 },
    cred,
    { manualLogin: true, onLoginReady: options.onLoginReady },
  );
  try {
    await b.run("browser_open");
    return cred;
  } finally {
    await b.close();
  }
}
