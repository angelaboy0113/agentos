import { loadEnvironments } from "../shared/environment-access.js";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAdministrator } from "./authorization.js";
import { createId } from "../shared/protocol.js";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export function enrollmentTarget(input) {
  if (
    !input ||
    !["uat", "prd"].includes(input.tier) ||
    !["nacos", "mysql"].includes(input.kind)
  )
    throw new Error("需要明确环境类型、UAT/PRD和入口地址");
  let u;
  try {
    u = new URL(input.url);
  } catch {
    throw new Error("入口地址格式无效");
  }
  if (u.username || u.password || u.search || (u.port && !/^\d+$/.test(u.port)))
    throw new Error("入口不能包含账号、密码或查询参数");
  if (
    input.kind === "nacos" &&
    (!["http:", "https:"].includes(u.protocol) ||
      u.pathname.replace(/\/$/, "") !== "/nacos")
  )
    throw new Error("当前网页接入仅支持Nacos /nacos入口");
  if (
    input.kind === "mysql" &&
    (u.protocol !== "mysql:" || !/^\/[A-Za-z0-9_-]+$/.test(u.pathname))
  )
    throw new Error("MySQL入口格式为mysql://主机:端口/库名，不带凭据");
  u.hash = "";
  return {
    kind: input.kind,
    tier: input.tier,
    url: u.toString().replace(/\/$/, ""),
  };
}
export async function requestEnrollment(context, turn) {
  if (!turn.questionId) throw new Error("请在已绑定项目群的话题中申请接入");
  const target = enrollmentTarget(turn.decision.environmentSetup);
  const projectId = context.projects.chatProjectMap[turn.chatId];
  if (!projectId || !context.projects.projects[projectId])
    throw new Error("项目尚未绑定");
  return context.store.transact((state) => {
    state.environmentEnrollments ??= {};
    const old = Object.values(state.environmentEnrollments).find(
      (e) => e.turnId === turn.id,
    );
    if (old) return { notice: "等待管理员确认本机接入", enrollmentId: old.id };
    if (
      Object.values(state.environmentEnrollments).filter((e) =>
        ["requested", "opening", "login_required"].includes(e.status),
      ).length >= 5
    )
      throw new Error("待接入请求过多，请先完成已有请求");
    const id = createId("ENR");
    state.environmentEnrollments[id] = {
      id,
      ...target,
      projectId,
      questionId: turn.questionId,
      turnId: turn.id,
      chatId: turn.chatId,
      profile: turn.profile,
      senderId: turn.senderId,
      status: "requested",
      createdAt: new Date().toISOString(),
    };
    return {
      enrollmentId: id,
      notice: `该环境尚未接入。请本群管理员回复此卡“同意本机接入”，确认 ${target.tier.toUpperCase()} 的 ${target.kind} 入口 ${target.url}。确认后将打开运行AgentOS电脑上的登录窗口；接入不等于批准生产查询，密码不要发到群里。`,
    };
  });
}
export async function approveEnrollment(
  context,
  turn,
  launch = launchEnrollment,
) {
  if (!isAdministrator(context.projects, turn))
    throw new Error("只有本群管理员可以确认新环境接入");
  const e = await context.store.transact((state) => {
    const e = Object.values(state.environmentEnrollments ?? {}).find(
      (x) => x.questionId === turn.questionId && x.status === "requested",
    );
    if (
      !e ||
      e.chatId !== turn.chatId ||
      e.projectId !== context.projects.chatProjectMap[turn.chatId]
    )
      throw new Error("没有本话题待确认的接入申请");
    if (Date.now() - Date.parse(e.createdAt) > 1800000)
      throw new Error("接入申请已过期，请重新发起");
    if (
      Object.values(state.environmentEnrollments).some((x) =>
        ["opening", "login_required"].includes(x.status),
      )
    )
      throw new Error("本机已有接入窗口，请先完成");
    e.status = "opening";
    e.approver = { profile: turn.profile, senderId: turn.senderId };
    return structuredClone(e);
  });
  try {
    await launch(context, e);
  } catch {
    await context.store.transact((s) => {
      s.environmentEnrollments[e.id].status = "failed";
    });
    throw new Error("本机窗口未能启动；需要已登录的macOS桌面，未保存新环境");
  }
  return {
    notice:
      "正在启动本机接入窗口，尚未确认登录。请在运行AgentOS的电脑上完成登录与范围选择；完成后自动继续原问题。",
    enrollmentId: e.id,
  };
}
export async function launchEnrollment(context, e) {
  if (process.platform !== "darwin") throw new Error("当前自动弹窗仅支持macOS");
  const dir = path.join(
    context.config.dataDir,
    "environment-enrollments",
    e.id,
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const seed = path.join(dir, "request.json");
  await writeFile(
    seed,
    JSON.stringify({ ...e, projectsFile: context.config.projectsFile }),
    { mode: 0o600 },
  );
  const launcher = path.join(dir, "登录环境.command");
  await writeFile(
    launcher,
    `#!/bin/zsh\ncd ${quote(repo)} || exit 1\n${quote(process.execPath)} scripts/configure-environment.mjs --enrollment ${quote(seed)}\nprintf '\\n配置结束，可关闭窗口。\\n'\nread -r\n`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
  await new Promise((resolve, reject) => {
    const p = spawn("/usr/bin/open", ["-a", "Terminal", launcher], {
      stdio: "ignore",
    });
    p.once("error", reject);
    p.once("exit", (code) =>
      code ? reject(new Error("open failed")) : resolve(),
    );
  });
}
export async function pollEnrollments(context, load = loadEnvironments) {
  const state = await context.store.read();
  for (const e of Object.values(state.environmentEnrollments ?? {})) {
    if (!["requested", "opening", "login_required"].includes(e.status))
      continue;
    const expired = Date.now() - Date.parse(e.createdAt) > 1800000;
    let event;
    try {
      event = JSON.parse(
        await readFile(
          path.join(
            context.config.dataDir,
            "environment-enrollments",
            e.id,
            "status.json",
          ),
          "utf8",
        ),
      );
    } catch {}
    if (
      !expired &&
      (!event ||
        !["login_required", "complete", "failed"].includes(event.status) ||
        event.status === e.status)
    )
      continue;
    if (event?.status === "complete" && !expired) {
      try {
        const env = (await load()).environments[e.id.toLowerCase()];
        if (
          !env ||
          env.projectId !== e.projectId ||
          env.tier !== e.tier ||
          env.kind !== e.kind ||
          env.queries?.investigate?.mode !== "investigate"
        )
          event = { status: "failed" };
      } catch {
        event = { status: "failed" };
      }
    }
    await context.store.transact((s) => {
      const current = s.environmentEnrollments[e.id];
      if (!["requested", "opening", "login_required"].includes(current.status))
        return;
      const original = s.conversations.find((t) => t.id === e.turnId);
      const q = s.questions[e.questionId];
      if (!original || !q) return;
      const latest = s.conversations.find((t) => t.id === q.latestTurnId);
      if (
        latest &&
        ["thinking", "decided", "queued", "ready"].includes(latest.status)
      )
        return;
      current.status = expired ? "expired" : event.status;
      if (current.status === "complete") {
        // Resume original requester, never borrow the administrator's query authority.
        original.decision = {
          ...original.decision,
          action: "create_task",
          intent: "analysis",
          reply: "本机接入已完成，正在按原提问人的权限继续本次只读排查。",
          environmentSetup: null,
          environmentQuery: {
            environmentId: e.id.toLowerCase(),
            queryId: "investigate",
            parameters: [original.decision.instruction.slice(0, 200)],
          },
          requiresSourceInspection: false,
        };
        original.status = "decided";
        original.outcome = null;
        original.retryAt = null;
        original.actionError = null;
      } else {
        original.status = "ready";
        original.response =
          current.status === "login_required"
            ? e.kind === "mysql"
              ? "已在运行AgentOS的电脑上打开本机终端凭据输入。请输入专用只读账号；不要在群里发送密码。"
              : "已在运行AgentOS的电脑上打开登录界面。请在本机登录，然后选择允许读取的范围；不要在群里发送密码。"
            : "本次接入未完成或已超时，请重新发起；未自动继续查询。";
      }
      q.latestTurnId = original.id;
      q.generation++;
      original.sentParts = 0;
    });
  }
}
