import {isPendingEnrollment,isLiveEnrollment,sameEnrollmentScope} from '../shared/enrollment-lifecycle.js';
import { resolveProjectId } from '../shared/project-scope.js';
import {stateView} from '../shared/state-view.js';
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
  const candidates=connectionCandidates(await context.store.read(),turn,resolveProjectId(context.projects, turn.chatId, turn.profile));
  const source=target.kind==='mysql' ? candidates.find(c=>c.url===target.url && c.tier===target.tier && c.connectionSource) : null;
  const projectId = resolveProjectId(context.projects, turn.chatId, turn.profile);
  if (!projectId || !context.projects.projects[projectId])
    throw new Error("项目尚未绑定");
  return context.store.transact((state) => {
    state.environmentEnrollments ??= {};
    const old = Object.values(state.environmentEnrollments).find(
      (e) => e.turnId === turn.id,
    );
    if (old) return { notice: "等待管理员确认本机接入", enrollmentId: old.id };
    const replaced = Object.values(state.environmentEnrollments).filter(e =>
      e.status === "requested" && sameEnrollmentScope(e,{...turn,projectId}) && e.kind === target.kind && e.tier === target.tier);
    if (
      Object.values(state.environmentEnrollments).filter((e) =>
        isPendingEnrollment(e),
      ).length - replaced.length >= 5
    )
      throw new Error("待接入请求过多，请先完成已有请求");
    const id = createId("ENR");
    for (const previous of replaced) {
      previous.status = "superseded";
      previous.supersededBy = id;
      previous.supersededAt = new Date().toISOString();
    }
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
      notice: source ? `请管理员回复此卡“同意”，确认 ${target.tier.toUpperCase()} 数据库 ${target.url}。将从本次Nacos配置在Mac本机提取业务凭据、验证TLS证书与只读事务，并开放本库基础表的受控查询；账号本身可能有写权限。凭据不交给模型、不发群。接入成功后的受控只读查询自动执行，任何写操作仍需另行审批。` : `该环境尚未接入。请本群管理员回复此卡“同意”，确认 ${target.tier.toUpperCase()} 的 ${target.kind} 入口 ${target.url}。确认后将打开运行AgentOS电脑上的登录窗口；这是本机接入配置确认，接入后的受控只读查询自动执行，密码不要发到群里。`,
    };
  });
}
export async function approveEnrollment(
  context,
  turn,
  launch = launchEnrollment,
) {
  const awaiting=(Object.values((await context.store.read()).environmentEnrollments ?? {})).filter(e=>e.questionId===turn.questionId && e.chatId===turn.chatId && e.profile===turn.profile && e.projectId===resolveProjectId(context.projects, turn.chatId, turn.profile) && ['requested','awaiting_tls_confirmation'].includes(e.status));
  if(awaiting.length!==1) throw new Error('待审批事项不唯一或不存在，请回复具体待审批卡片');
  const withoutTls = awaiting[0].status==='awaiting_tls_confirmation';
  const confirmation=String(turn.content ?? '').replace(/<at\b[^>]*>.*?<\/at>/g,'').replace(/\s+/g,'').replace(/[。！!]$/,'').toUpperCase();
  if(withoutTls && !['同意','同意本目标使用非TLS'].includes(confirmation)) throw new Error('请回复本待审批卡片“同意”；未明确同意前保持TLS');
  if (!isAdministrator(context.projects, turn))
    throw new Error("只有本群管理员可以确认新环境接入");
  const e = await context.store.transact((state) => {
    const e = state.environmentEnrollments?.[awaiting[0].id];
    if (
      !e || e.status !== (withoutTls ? "awaiting_tls_confirmation" : "requested")
      || e.profile !== turn.profile || e.questionId !== turn.questionId ||
      e.chatId !== turn.chatId ||
      e.projectId !== resolveProjectId(context.projects, turn.chatId, turn.profile)
    )
      throw new Error("没有本话题待确认的接入申请");
    if (Date.now() - Date.parse(e.createdAt) > 1800000)
      throw new Error("接入申请已过期，请重新发起");
    if (
      Object.values(state.environmentEnrollments).some((x) =>
        isLiveEnrollment(x),
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
    if(needsTlsConsent) return {enrollmentId:e.id,notice:`${diagnostic}\n\n目标：${e.tier.toUpperCase()} · ${e.url}。若接受此目标失去TLS传输保护，请管理员回复本卡“同意”。仅此数据库例外，保留只读事务、查询模板与参数限制；未确认前不重试。`};
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
export async function resumeAvailableSetupSources(context, load = loadEnvironments) {
 const state=await context.store.read();
 const waiting=(state.conversations??[]).filter(t=>t.status==='sent'&&t.setupPending&&t.decision?.action==='request_environment_setup'&&t.decision.environmentSetup?.kind==='mysql'&&!t.decision.environmentSetup.url&&state.questions?.[t.questionId]?.latestTurnId===t.id);
 if(!waiting.length)return;
 const config=await load();
 for(const turn of waiting){
  const projectId=resolveProjectId(context.projects,turn.chatId,turn.profile);
  const sources=Object.values(config.environments??{}).filter(e=>e.projectId===projectId&&e.tier===turn.decision.environmentSetup.tier&&e.kind==='nacos'&&e.queries?.investigate?.mode==='investigate');
  if(sources.length!==1)continue;
  await context.store.transact(s=>{
   const t=s.conversations.find(x=>x.id===turn.id),q=s.questions?.[turn.questionId];
   if(t?.status!=='sent'||!t.setupPending||q?.latestTurnId!==turn.id||(s.jobs??[]).some(j=>j.questionId===q.id&&['queued','running','cancelling'].includes(j.status))||Object.values(s.environmentEnrollments??{}).some(e=>e.questionId===q.id&&isPendingEnrollment(e)))return;
   t.status='decided';t.setupPending=false;t.outcome=null;t.response=null;t.actionError=null;t.sourceConnectionRecoveredAt=new Date().toISOString();q.generation++;
  });
 }
}
export async function pollEnrollments(context, load = loadEnvironments) {
  await resumeAvailableSetupSources(context,load);
  const needed=await stateView(context.store,s=>Object.values(s.environmentEnrollments??{}).some(e=>isPendingEnrollment(e))||(s.jobs??[]).some(j=>{if(j.status!=='completed'||(!j.environmentAccess&&!j.completedEnvironmentReads?.length))return false;const t=s.conversations?.find(t=>t.id===j.sourceMessageId);return t?.decision?.environmentSetup?.kind==='mysql'&&!t.decision.environmentSetup.url&&t.decision.action==='create_task'&&(!j.connectionEnrollmentHandled||t.setupPending); }));
  if(!needed)return;
  let state = await context.store.read();
  // Resume metadata discovery without borrowing another user's PRD authority.
  for (const job of state.jobs ?? []) {
    const turn = (state.conversations ?? []).find(t=>t.id===job.sourceMessageId);
    if (!turn || job.status!=='completed' || (!job.environmentAccess&&!job.completedEnvironmentReads?.length)
      || turn.decision?.environmentSetup?.kind!=='mysql' || turn.decision.environmentSetup.url
      || turn.decision.action!=='create_task') continue;
    const candidates=connectionCandidates(state,turn,job.projectId).filter(e=>e.tier===turn.decision.environmentSetup.tier && e.connectionSource && (!turn.setupTargetUrl||e.url===turn.setupTargetUrl));
    // Recover only the old incomplete-metadata wait, never replay an enrollment or query.
    if(job.connectionEnrollmentHandled && !(candidates.length===1 && turn.setupPending
      && turn.response?.startsWith('尚未取得完整数据库地址；')
      && state.questions?.[turn.questionId]?.latestTurnId===turn.id
      && (state.jobs??[]).filter(j=>j.questionId===turn.questionId).at(-1)?.id===job.id
      && !Object.values(state.environmentEnrollments??{}).some(e=>e.turnId===turn.id)))continue;
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
    if (!isPendingEnrollment(e))
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
        !["login_required", "scope_required", "complete", "failed"].includes(event.status) ||
        event.status === e.status && (event.loginIssue??null)===(e.loginIssue??null))
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
      if (!isPendingEnrollment(current))
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
      current.loginIssue = event?.loginIssue ?? null;
      current.namespaces = event?.namespaces ?? current.namespaces;
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
        original.setupPending = ["login_required","scope_required"].includes(current.status);
        original.status = "ready";
        original.response =
          current.status === "scope_required" ? "Nacos 登录已成功，正在等待选择命名空间范围；尚未取数。" : current.status === "login_required"
            ? e.kind === "mysql"
              ? "已在运行AgentOS的电脑上打开本机终端凭据输入。默认使用专用只读账号；如只能使用业务账号，请在本机向导明确确认受控模式。不要在群里发送密码。"
              : current.loginIssue ? "登录尚未通过认证，请核对账号密码，或在本机完成验证码；可在本话题重新提供凭据。" : current.credentialReceivedAt ? "已收到凭据，正在通过本机独立窗口尝试登录，尚未确认认证成功；成功后仍需选择允许读取的命名空间。" : "正在等待 Nacos 登录。请在本话题 @助手 提供账号密码，由独立窗口自动填写；也可在本机手动登录。验证码和读取范围选择仍需本人完成。"
            : "本次接入未完成或已超时，请重新发起；未自动继续查询。";
      }
      q.latestTurnId = original.id;
      q.generation++;
      original.sentParts = 0;
    });
  }
}
