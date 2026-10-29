import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, lstat, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "./config.js";
import {
  WorkbenchStore,
  uid,
  now,
  canRead,
  canManage,
  requireTopic,
  audit,
  enqueueNotice,
  topicSummary,
} from "./store.js";
import { Auth } from "./auth.js";
import { Notifications } from "./notifications.js";
import { PreviewAdapter } from "./preview-adapter.js";
import { pruneWorkbench } from "./retention.js";
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const json = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const fail = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw fail("请求内容不是有效 JSON");
  }
}
export async function safeFile(root, file) {
  const alias = path.resolve(root),
    parent = await realpath(root),
    relative = path.relative(
      path.resolve(file).startsWith(parent + path.sep) ? parent : alias,
      path.resolve(file),
    );
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw fail("文件不可用", 404);
  const target = path.join(parent, relative);
  let current = parent;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw fail("文件不可用", 404);
  }
  const info = await lstat(target);
  if (!info.isFile() || !(await realpath(target)).startsWith(parent + path.sep))
    throw fail("文件不可用", 404);
  return { file: target, bytes: info.size };
}
const statusLabel = {
  queued: "排队中",
  running: "处理中",
  completed: "已完成",
  failed: "执行失败",
  blocked: "任务受阻",
  awaiting_clarification: "等待补充",
  awaiting_approval: "等待确认",
  awaiting_environment_approval: "等待授权",
  cancelled: "已取消",
  cancelling: "正在停止",
};
export async function createWorkbench(
  config,
  { adapter, sendNotification } = {},
) {
  const store = await new WorkbenchStore(config.dataDir).start();
  config = {
    ...config,
    sessionSecret: config.sessionSecret ?? randomBytes(32).toString("hex"),
  };
  if (config.mode === "preview")
    await store.tx((s) => {
      for (const u of [
        { id: "preview-owner", name: "负责人", employeeNo: "体验账号" },
        { id: "preview-colleague", name: "林晓", employeeNo: "体验同事" },
        { id: "preview-other", name: "陈远", employeeNo: "体验同事" },
      ])
        s.users[u.id] = u;
    });
  const auth = new Auth(store, config),
    notifications = new Notifications(store, config, sendNotification);
  if (!adapter)
    adapter =
      config.mode === "preview"
        ? new PreviewAdapter(config)
        : new (await import("./os-adapter.js")).OSAdapter(config);
  try {
    await adapter.start((await store.read()).topics);
  } catch (e) {
    await store.close();
    throw e;
  }
  let syncing = null,
    closed = false;
  function sync() {
    if (syncing || closed) return syncing ?? Promise.resolve();
    syncing = (async () => {
      try {
        const state = await store.read();
        for (const old of Object.values(state.topics)) {
          // Retry a durable ingress after restart. Adapter submit deduplicates by message ID.
          for (const m of old.messages.filter(
            (m) => m.kind === "user" && m.dispatch !== "sent",
          )) {
            try {
              await adapter.submit(old, m);
              await store.tx((s) => {
                const x = s.topics[old.id]?.messages.find((x) => x.id === m.id);
                if (x) {
                  x.dispatch = "sent";
                  delete x.error;
                }
              });
            } catch {
              await store.tx((s) => {
                const x = s.topics[old.id]?.messages.find((x) => x.id === m.id);
                if (x) x.error = "后端暂未接收，正在自动重试";
              });
            }
          }
          const fresh = (await store.read()).topics[old.id];
          if (!fresh) continue;
          if (
            fresh.messages.some(
              (m) => m.kind === "user" && m.dispatch !== "sent",
            )
          ) {
            await store.tx((s) => {
              const t = s.topics[old.id];
              if (t) {
                t.status = "queued";
                t.progress = "正在等待 OS 接收，已保留请求并自动重试";
              }
            });
            continue;
          }
          let snapshot;
          try {
            snapshot = await adapter.snapshot(fresh);
          } catch {
            await store.tx((s) => {
              if (s.topics[old.id])
                s.topics[old.id].progress =
                  "暂时无法读取 OS 状态，已有内容已保留，正在重连";
            });
            continue;
          }
          await store.tx((s) => {
            const t = s.topics[old.id];
            if (!t) return;
            for (const m of snapshot.messages ?? [])
              if (!t.messages.some((x) => x.id === m.id)) t.messages.push(m);
            t.status = snapshot.status;
            t.progress = snapshot.progress ?? null;
            t.jobId = snapshot.jobId ?? null;
            const outputs = new Map((t.outputs ?? []).map((f) => [f.id, f]));
            for (const f of snapshot.files ?? [])
              if (!outputs.has(f.id))
                outputs.set(f.id, { ...f, recordedAt: now() });
            t.outputs = [...outputs.values()];
            const last = t.messages.filter((m) => m.kind === "user").at(-1);
            if (
              last &&
              [
                "completed",
                "failed",
                "blocked",
                "cancelled",
                "awaiting_clarification",
                "awaiting_approval",
                "awaiting_environment_approval",
              ].includes(t.status) &&
              t.resultNoticeFor !== last.id + ":" + t.status
            ) {
              t.updatedAt = now();
              t.resultNoticeFor = last.id + ":" + t.status;
              enqueueNotice(s, config, t, "result", t.resultNoticeFor, [
                t.ownerId,
                ...t.members,
                ...config.ownerIds,
              ]);
            }
          });
        }
      } finally {
      }
    })();
    const work = syncing;
    work
      .finally(() => {
        if (syncing === work) syncing = null;
      })
      .catch(() => {});
    return work;
  }
  async function view(id, actor) {
    return store.tx((s) => {
      const t = requireTopic(s, id, actor, config);
      audit(s, actor, "view", id);
      return {
        topic: {
          ...topicSummary(t, s),
          statusLabel: statusLabel[t.status] ?? "处理中",
          progress: t.progress,
          jobId: t.jobId,
          canManage: canManage(t, actor, config),
          participants: [
            ...new Set([t.ownerId, ...t.members, ...config.ownerIds]),
          ].map((id) => ({
            id,
            name: s.users[id]?.name ?? "系统负责人",
            role: config.ownerIds.includes(id)
              ? "系统负责人"
              : id === t.ownerId
                ? "发起人"
                : "参与人",
          })),
        },
        messages: t.messages.map(({ attachments, dispatch, ...m }) => ({
          ...m,
          attachments: (attachments ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            bytes: a.bytes,
          })),
        })),
        files: [
          ...t.uploads.map((f) => ({
            id: f.id,
            name: f.name,
            bytes: f.bytes,
            kind: "input",
          })),
          ...(t.outputs ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            bytes: f.bytes,
            kind: "output",
          })),
        ],
      };
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, config.publicUrl),
        p = url.pathname;
      if (p === "/health") {
        return json(res, 200, {
          ok: true,
          mode: config.mode,
          engine:
            config.mode === "preview"
              ? "synthetic-preview"
              : "isolated-agentos-core",
        });
      }
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(p)) {
        const file = p === "/" ? "index.html" : p.slice(1);
        res.writeHead(200, {
          "content-type": file.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(await readFile(path.join(publicDir, file)));
      }
      if (
        p === "/auth/login" &&
        req.method === "GET" &&
        config.mode === "live"
      ) {
        res.writeHead(302, { location: auth.start(res) });
        return res.end();
      }
      if (
        p === "/auth/callback" &&
        req.method === "GET" &&
        config.mode === "live"
      ) {
        await auth.callback(req, url, res);
        res.writeHead(302, { location: "/" });
        return res.end();
      }
      if (
        p === "/api/preview-login" &&
        req.method === "POST" &&
        config.mode === "preview"
      ) {
        if (req.headers.origin !== config.publicUrl)
          throw fail("请求来源校验失败", 403);
        const b = await body(req),
          s = await store.read(),
          u = s.users[b.id];
        if (!u || !u.id.startsWith("preview-")) throw fail("无效体验账号");
        await auth.createSession(u, res);
        return json(res, 200, { ok: true });
      }
      const actor = await auth.actor(req);
      if (p === "/api/me" && req.method === "GET")
        return json(res, 200, {
          user: actor
            ? {
                id: actor.id,
                name: actor.name,
                employeeNo: actor.employeeNo,
                owner: config.ownerIds.includes(actor.id),
              }
            : null,
          csrf: actor?.csrf,
          mode: config.mode,
          notificationsEnabled: config.notifications.enabled,
          projects: config.allowedProjectIds.map((id) => ({
            id,
            name: config.projectNames?.[id] ?? id,
          })),
          previewUsers:
            config.mode === "preview" ? (await store.read()).users : undefined,
        });
      if (!actor) throw fail("请先使用飞书登录", 401);
      if (!["GET", "HEAD"].includes(req.method)) auth.checkWrite(req, actor);
      if (p === "/auth/logout" && req.method === "POST") {
        await auth.logout(req, res);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/topics" && req.method === "GET") {
        const s = await store.read(),
          scope = url.searchParams.get("scope") ?? "mine";
        if (scope === "all" && !config.ownerIds.includes(actor.id))
          throw fail("仅系统负责人可查看全部对话", 403);
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const topics = Object.values(s.topics)
          .filter(
            (t) =>
              canRead(t, actor, config) &&
              (scope === "all" || scope === "mentions"
                ? scope === "all" || t.members.includes(actor.id)
                : t.ownerId === actor.id),
          )
          .filter(
            (t) =>
              !q ||
              [
                t.title,
                s.users[t.ownerId]?.name ?? "",
                ...t.messages.map((m) => m.text),
              ]
                .join("\n")
                .toLowerCase()
                .includes(q),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((t) => topicSummary(t, s));
        return json(res, 200, { topics });
      }
      if (p === "/api/topics" && req.method === "POST") {
        const b = await body(req);
        if (!config.allowedProjectIds.includes(b.projectId))
          throw fail("项目尚未接入");
        const t = {
          id: uid(),
          title: "新对话",
          projectId: b.projectId,
          ownerId: actor.id,
          members: [],
          messages: [],
          uploads: [],
          outputs: [],
          status: "completed",
          createdAt: now(),
          updatedAt: now(),
        };
        await store.tx((s) => {
          s.topics[t.id] = t;
          audit(s, actor, "create", t.id);
        });
        return json(res, 201, { topic: topicSummary(t, await store.read()) });
      }
      if (p === "/api/people" && req.method === "GET") {
        const s = await store.read(),
          q = (url.searchParams.get("q") ?? "").toLowerCase();
        return json(res, 200, {
          people: Object.values(s.users)
            .filter(
              (u) =>
                u.id !== actor.id &&
                [u.name, u.employeeNo].join(" ").toLowerCase().includes(q),
            )
            .map(({ id, name, employeeNo }) => ({ id, name, employeeNo })),
          note: "仅展示已登录本工作台的企业成员",
        });
      }
      if (p === "/api/files" && req.method === "GET") {
        const s = await store.read();
        return json(res, 200, {
          files: Object.values(s.topics)
            .filter((t) => canRead(t, actor, config))
            .flatMap((t) =>
              [...t.uploads, ...(t.outputs ?? [])].map((f) => ({
                id: f.id,
                name: f.name,
                bytes: f.bytes,
                topicId: t.id,
                topicTitle: t.title,
              })),
            ),
        });
      }
      const match = p.match(
        /^\/api\/topics\/([a-f0-9-]+)(?:\/(messages|members|files)(?:\/([^/]+))?)?$/,
      );
      if (!match) throw fail("接口不存在", 404);
      const [, id, action, itemId] = match;
      let s = await store.read(),
        topic = requireTopic(s, id, actor, config);
      if (!action && req.method === "GET")
        return json(res, 200, await view(id, actor));
      if (action === "messages" && req.method === "POST") {
        const b = await body(req);
        if (
          typeof b.text === "string" &&
          /(?:^|\s|[;；])(?:账号|用户名|username)\s*[:：=]\s*\S+/i.test(
            b.text,
          ) &&
          /(?:^|\s|[;；])(?:密码|password|passwd)\s*[:：=]\s*\S+/i.test(b.text)
        )
          throw fail(
            "请在本机独立浏览器完成网页登录，不要把账号密码写进聊天。",
          );
        if (typeof b.text !== "string" || !b.text.trim())
          throw fail("请填写问题或附件说明");
        if (
          typeof b.requestId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(b.requestId)
        )
          throw fail("缺少请求标识");
        await store.tx((s) => {
          const t = requireTopic(s, id, actor, config);
          if (
            t.messages.some(
              (m) => m.requestId === b.requestId && m.senderId === actor.id,
            )
          )
            return;
          const selected = (b.attachmentIds ?? []).map((fid) =>
            t.uploads.find((f) => f.id === fid),
          );
          if (selected.some((f) => !f)) throw fail("附件不属于当前话题");
          const m = {
            id: uid(),
            requestId: b.requestId,
            kind: "user",
            text: b.text.trim(),
            senderId: actor.id,
            senderName: actor.name,
            at: now(),
            attachments: selected,
            dispatch: "pending",
          };
          t.messages.push(m);
          if (t.title === "新对话")
            t.title = m.text.replace(/\s+/g, " ").slice(0, 48);
          t.status = "queued";
          t.updatedAt = now();
          audit(s, actor, "message", id);
          enqueueNotice(s, config, t, "question", m.id, config.ownerIds);
        });
        void sync();
        return json(res, 202, { accepted: true });
      }
      if (action === "members" && req.method === "POST") {
        const b = await body(req);
        await store.tx((s) => {
          const t = requireTopic(s, id, actor, config);
          if (!canManage(t, actor, config))
            throw fail("仅发起人和负责人可以邀请成员", 403);
          if (
            typeof b.userId !== "string" ||
            !Object.hasOwn(s.users, b.userId) ||
            b.userId === t.ownerId
          )
            throw fail("请从已登录成员中选择");
          if (t.members.includes(b.userId)) return;
          t.members.push(b.userId);
          audit(s, actor, "invite", id);
          enqueueNotice(s, config, t, "mention", uid(), [b.userId]);
        });
        return json(res, 200, { ok: true });
      }
      if (action === "members" && itemId && req.method === "DELETE") {
        await store.tx((s) => {
          const t = requireTopic(s, id, actor, config);
          if (!canManage(t, actor, config)) throw fail("无权移除参与人", 403);
          t.members = t.members.filter((x) => x !== itemId);
          audit(s, actor, "revoke", id);
        });
        return json(res, 200, { ok: true });
      }
      if (action === "files" && !itemId && req.method === "POST") {
        const name = decodeURIComponent(
            req.headers["x-file-name"] ?? "附件",
          ).replace(/[\x00-\x1f\\/]/g, "_"),
          fid = uid(),
          dir = path.join(config.dataDir, "files", id);
        await safeDirectory(config.dataDir, dir);
        const target = path.join(
            dir,
            fid + path.extname(name).replace(/[^.a-zA-Z0-9]/g, ""),
          ),
          partial = target + ".part";
        let bytes = 0;
        const hash = createHash("sha256");
        req.on("data", (c) => {
          bytes += c.length;
          hash.update(c);
        });
        try {
          await pipeline(
            req,
            createWriteStream(partial, { flags: "wx", mode: 0o600 }),
          );
          await rename(partial, target);
          await store.tx((s) => {
            const t = requireTopic(s, id, actor, config);
            t.uploads.push({
              id: fid,
              name,
              path: target,
              bytes,
              sha256: hash.digest("hex"),
              type: /\.(png|jpg|jpeg|webp)$/i.test(name) ? "image" : "file",
              contentType: "application/octet-stream",
              createdAt: now(),
            });
            audit(s, actor, "upload", id);
          });
          return json(res, 201, { file: { id: fid, name, bytes } });
        } catch (e) {
          await rm(partial, { force: true });
          await rm(target, { force: true });
          throw e;
        }
      }
      if (action === "files" && itemId && req.method === "GET") {
        const file =
          topic.uploads.find((f) => f.id === itemId) ??
          topic.outputs?.find((f) => f.id === itemId);
        if (!file) throw fail("文件不存在或尚未完成核验", 404);
        const location = file.path ?? (await adapter.output(file));
        if (!location) throw fail("文件暂时不可用，请稍后重试", 404);
        const info = await safeFile(config.dataDir, location);
        await store.tx((s) => {
          requireTopic(s, id, actor, config);
          audit(s, actor, "download", id);
        });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": info.bytes,
          "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "cache-control": "no-store",
        });
        return createReadStream(info.file).pipe(res);
      }
      throw fail("操作不存在", 404);
    } catch (e) {
      if (!res.headersSent)
        json(res, e.statusCode ?? 500, {
          error: e.statusCode
            ? e.message
            : "暂时无法完成操作，请保留当前页面后重试",
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  const timer = setInterval(() => void sync().catch(() => {}), 1500);
  timer.unref();
  notifications.start();
  const retentionTimer = setInterval(
    () => void pruneWorkbench(store, config).catch(() => {}),
    3600000,
  );
  retentionTimer.unref();
  return {
    server,
    store,
    auth,
    sync,
    adapter,
    async close() {
      if (!(await adapter.stop())) return false;
      closed = true;
      clearInterval(timer);
      clearInterval(retentionTimer);
      await notifications.stop();
      await new Promise((r) => server.close(r));
      await store.close();
      return true;
    },
  };
}
async function safeDirectory(root, dir) {
  const actual = await realpath(root),
    relative = path.relative(path.resolve(root), path.resolve(dir));
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw fail("上传目录不可用");
  let next = actual;
  for (const part of relative.split(path.sep)) {
    next = path.join(next, part);
    let info;
    try {
      info = await lstat(next);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await mkdir(next, { mode: 0o700 });
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw fail("上传目录不可用");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  if (config.mode === "preview") {
    config.ownerIds = ["preview-owner"];
    config.allowedProjectIds = ["tpm"];
    config.projectNames = { tpm: "TPM 营销平台" };
  }
  const app = await createWorkbench(config);
  await new Promise((r) => app.server.listen(config.port, config.host, r));
  console.log(`AgentOS workbench ${config.mode}: ${config.publicUrl}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (!(await app.close()))
        console.log("仍有任务执行，保持服务；请等待完成后再停止。");
    });
}
