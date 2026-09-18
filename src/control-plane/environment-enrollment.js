import { failureDiagnostic } from '../shared/failure-diagnostic.js';
import { automaticDatabaseEnrollment } from './automatic-database-enrollment.js';
import { connectionCandidates } from '../shared/connection-endpoints.js';
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
  const candidates=connectionCandidates(await context.store.read(),turn,context.projects.chatProjectMap[turn.chatId]);
  const source=target.kind==='mysql' ? candidates.find(c=>c.url===target.url && c.tier===target.tier && c.connectionSource) : null;
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
        ["requested", "opening", "login_required", "awaiting_tls_confirmation"].includes(e.status),
      ).length >= 5
    )
      throw new Error("待接入请求过多，请先完成已有请求");
    const id = createId("ENR");
    state.environmentEnrollments[id] = {
      id,
      ...target,
      ...(source ? {databaseSource:source} : {}),
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
      notice: source ? `请管理员回复此卡“同意”，确认 ${target.tier.toUpperCase()} 数据库 ${target.url}。将从本次Nacos配置在Mac本机提取业务凭据、验证TLS证书与只读事务，并开放本库基础表的受控查询；账号本身可能有写权限。凭据不交给模型、不发群。接入不代替成员PRD查询审批。` : `该环境尚未接入。请本群管理员回复此卡“同意”，确认 ${target.tier.toUpperCase()} 的 ${target.kind} 入口 ${target.url}。确认后将打开运行AgentOS电脑上的登录窗口；接入不等于批准生产查询，密码不要发到群里。`,
    };
  });
}
export async function approveEnrollment(
  context,
  turn,
  launch = launchEnrollment,
) {
  const awaiting=(Object.values((await context.store.read()).environmentEnrollments ?? {})).filter(e=>e.questionId===turn.questionId && e.chatId===turn.chatId && e.projectId===context.projects.chatProjectMap[turn.chatId] && ['requested','awaiting_tls_confirmation'].includes(e.status));
  if(awaiting.length!==1) throw new Error('待审批事项不唯一或不存在，请回复具体待审批卡片');
  const withoutTls = awaiting[0].status==='awaiting_tls_confirmation';
  const confirmation=String(turn.content ?? '').replace(/<at\b[^>]*>.*?<\/at>/g,'').replace(/\s+/g,'').replace(/[。！!]$/,'').toUpperCase();
  if(withoutTls && !['同意','同意本目标使用非TLS'].includes(confirmation)) throw new Error('请回复本待审批卡片“同意”；未明确同意前保持TLS');
  if (!isAdministrator(context.projects, turn))
    throw new Error("只有本群管理员可以确认新环境接入");
  const e = await context.store.transact((state) => {
    const e = Object.values(state.environmentEnrollments ?? {}).find(
      (x) => x.questionId === turn.questionId && x.status === (withoutTls ? "awaiting_tls_confirmation" : "requested"),
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
    if(withoutTls) {
      if(!e.databaseSource || !e.diagnostic?.startsWith('错误码：TLS_UNSUPPORTED')) throw new Error('没有可确认的TLS例外');
      e.tlsException={url:e.url,approverId:turn.senderId,profile:turn.profile,confirmedAt:new Date().toISOString()};
    }
    e.status = "opening";
    e.approver = { profile: turn.profile, senderId: turn.senderId };
    return structuredClone(e);
  });
  try {
    await launch(context, e);
  } catch (error) {
    const diagnostic = failureDiagnostic(error);
    const needsTlsConsent = e.databaseSource && !e.tlsException && diagnostic.startsWith('错误码：TLS_UNSUPPORTED');
    await context.store.transact((s) => {
      s.environmentEnrollments[e.id].status = needsTlsConsent ? "awaiting_tls_confirmation" : "failed";
      s.environmentEnrollments[e.id].diagnostic = diagnostic;
    });
    if(needsTlsConsent) return {enrollmentId:e.id,notice:`${diagnostic}\n\n目标：${e.tier.toUpperCase()} · ${e.url}。若接受此目标失去TLS传输保护，请管理员回复本卡“同意”。仅此数据库例外，保留只读事务、查询限制及PRD审批；未确认前不重试。`};
    throw new Error(e.databaseSource ? "自动连接未完成。\n"+failureDiagnostic(error) : "本机窗口未能启动；需要已登录的macOS桌面，未保存新环境");
  }
  return {
    notice: e.databaseSource ? "自动连接与只读事务验证已完成，正在按原发起人的权限继续查询。" :
      "正在启动本机接入窗口，尚未确认登录。请在运行AgentOS的电脑上完成登录与范围选择；完成后自动继续原问题。",
    enrollmentId: e.id,
  };
}
export async function launchEnrollment(context, e) {
  if(e.databaseSource) return automaticDatabaseEnrollment(context,e);
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
  let state = await context.store.read();
  // Resume metadata discovery without borrowing another user's PRD authority.
  for (const job of state.jobs ?? []) {
    const turn = (state.conversations ?? []).find(t=>t.id===job.sourceMessageId);
    if (!turn || job.connectionEnrollmentHandled || job.status!=='completed' || !job.environmentAccess
      || turn.decision?.environmentSetup?.kind!=='mysql' || turn.decision.environmentSetup.url
      || turn.decision.action!=='create_task') continue;
    const candidates=connectionCandidates(state,turn,job.projectId).filter(e=>e.tier===turn.decision.environmentSetup.tier && e.connectionSource && (!turn.setupTargetUrl||e.url===turn.setupTargetUrl));
    let outcome;
    if(candidates.length===1) outcome=await requestEnrollment(context,{...turn,decision:{...turn.decision,environmentSetup:{...turn.decision.environmentSetup,url:candidates[0].url}}});
    else outcome={notice:candidates.length ? '发现多个数据库入口，请选择目标库名：'+candidates.map(e=>`${e.host}:${e.port}/${e.database}`).join('；') : '尚未取得完整数据库地址；请补充目标配置或命名空间，已有查询结果保留，未尝试数据库登录。'};
    await context.store.transact(s=>{
      const j=s.jobs.find(x=>x.id===job.id),t=s.conversations.find(x=>x.id===turn.id),q=s.questions?.[turn.questionId];
      j.connectionEnrollmentHandled=true;
      if(q?.latestTurnId===turn.id) {t.outcome=outcome;t.response=outcome.notice;t.status='ready';t.sentParts=0;q.generation++;}
    });
  }
  state = await context.store.read();
  for (const e of Object.values(state.environmentEnrollments ?? {})) {
    if (!["requested", "opening", "login_required", "awaiting_tls_confirmation"].includes(e.status))
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
      if (!["requested", "opening", "login_required", "awaiting_tls_confirmation"].includes(current.status))
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
        original.setupPending = false;
        original.environmentResumeKey = e.id;
        original.status = "decided";
        original.outcome = null;
        original.retryAt = null;
        original.actionError = null;
      } else {
        original.setupPending = current.status === "login_required";
        original.status = "ready";
        original.response =
          current.status === "login_required"
            ? e.kind === "mysql"
              ? "已在运行AgentOS的电脑上打开本机终端凭据输入。默认使用专用只读账号；如只能使用业务账号，请在本机向导明确确认受控模式。不要在群里发送密码。"
              : "已在运行AgentOS的电脑上打开登录界面。请在本机登录，然后选择允许读取的范围；不要在群里发送密码。"
            : "本次接入未完成或已超时，请重新发起；未自动继续查询。";
      }
      q.latestTurnId = original.id;
      q.generation++;
      original.sentParts = 0;
    });
  }
}
