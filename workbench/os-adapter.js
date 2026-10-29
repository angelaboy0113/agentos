// Reuse the OS engine in a separate process/state, never inject Web data into a real group.
import path from "node:path";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createId } from "../src/shared/protocol.js";
import { reportEligible } from "../src/shared/report-acceptance.js";
import { reportFile } from "../src/shared/report-files.js";
export class OSAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.verifiedOutputs = new Set();
  }
  async start(topics) {
    const c = this.config,
      coreDir = path.resolve(c.coreConfigDir),
      data = path.join(c.dataDir, "engine");
    if (
      path.resolve(c.dataDir) ===
        path.resolve(c.existingDataDir ?? path.join(coreDir, "../data")) ||
      path
        .resolve(c.dataDir)
        .startsWith(
          path.resolve(c.existingDataDir ?? path.join(coreDir, "../data")) +
            path.sep,
        )
    )
      throw new Error("Web engine must have its own data directory");
    await mkdir(data, { recursive: true, mode: 0o700 });
    // Copy configuration into this instance; enrollment must never write the running OS files.
    const ownConfig = path.join(data, "config");
    await mkdir(ownConfig, { recursive: true, mode: 0o700 });
    for (const name of [
      "environments.local.json",
      "contacts.local.json",
      "agents.local.json",
    ]) {
      const target = path.join(ownConfig, name);
      try {
        await readFile(target);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        const source = await readFile(path.join(coreDir, name), "utf8").catch(
          (error) => {
            if (error.code === "ENOENT")
              return name === "environments.local.json"
                ? JSON.stringify({ version: 1, environments: {} })
                : "{}";
            throw error;
          },
        );
        await writeFile(target, source, { mode: 0o600, flag: "wx" });
      }
    }
    process.env.AGENTOS_ENVIRONMENTS_FILE = path.join(
      ownConfig,
      "environments.local.json",
    );
    process.env.AGENTOS_CONTACTS_FILE = path.join(
      ownConfig,
      "contacts.local.json",
    );
    process.env.AGENTOS_CONTACT_CHANNELS_FILE = path.join(
      data,
      "contacts-disabled.local.json",
    );
    process.env.AGENTOS_BROWSER_MODE = "isolated";
    process.env.AGENTOS_DATA_DIR = data;
    const runtime = JSON.parse(
      await readFile(
        path.join(coreDir, "codex-runtime.local.json"),
        "utf8",
      ).catch(() => "{}"),
    );
    if (runtime.model) process.env.AGENTOS_CODEX_MODEL = runtime.model;
    if (runtime.reasoningEffort)
      process.env.AGENTOS_CODEX_REASONING_EFFORT = runtime.reasoningEffort;
    if (Object.hasOwn(runtime, "proxyUrl"))
      process.env.AGENTOS_CODEX_PROXY_URL = runtime.proxyUrl;
    if (runtime.codexBin && runtime.codexBin !== "codex")
      process.env.CODEX_BIN = runtime.codexBin;
    const { loadProjects, loadAgents } = await import(
      "../src/control-plane/config.js"
    );
    const source = await loadProjects(
      path.join(coreDir, "projects.local.json"),
    );
    this.projects = {
      ...source,
      projects: Object.fromEntries(
        Object.entries(source.projects)
          .filter(([id]) => c.allowedProjectIds.includes(id))
          .map(([id, p]) => [
            id,
            {
              ...p,
              analysisSnapshotRoot: path.join(data, "analysis-sources", id),
            },
          ]),
      ),
      chatProjectMap: {},
      topicChatIds: [],
      retiredChatIds: [],
    };
    if (!Object.keys(this.projects.projects).length)
      throw new Error("No configured projects match allowedProjectIds");
    for (const t of Object.values(topics)) this.bind(t);
    const agents = await loadAgents(path.join(coreDir, "agents.local.json"));
    this.profile =
      c.notifications.profile ?? agents.agents.owner_intake?.profile;
    if (!this.profile) throw new Error("OS owner profile missing");
    const memory = path.join(data, "memory.local.json");
    await writeFile(memory, JSON.stringify({ enabled: false }), {
      mode: 0o600,
    });
    const conversation = path.join(data, "conversation.local.json");
    await writeFile(
      conversation,
      JSON.stringify({ groupSessions: true, questionCards: true }),
      { mode: 0o600 },
    );
    const { createControlPlane } = await import(
      "../src/control-plane/server.js"
    );
    const token = randomBytes(32).toString("hex");
    // Local transport consumes the existing durable card mechanism without any external send.
    const ack = async () => ({
      message_id: "web_" + randomBytes(16).toString("hex"),
    });
    const { LarkCliFeishuClient } = await import(
      "../src/control-plane/lark-cli.js"
    );
    const contactReader = new LarkCliFeishuClient({ dataDir: data });
    const localTransport = {
      contactRequest: contactReader.contactRequest.bind(contactReader),
      reply: ack,
      send: ack,
      replyCard: ack,
      sendCard: ack,
      updateCard: ack,
      replyFile: ack,
      replyImage: ack,
    };
    const noKnowledge = {
      inflight: new Set(),
      recover: async () => {},
      close: async () => {},
      capture: () => {},
      reuse: async (t, p, d) => d,
      candidates: async () => ({ enabled: false, candidates: [] }),
    };
    this.core = await createControlPlane({
      dataDir: data,
      host: "127.0.0.1",
      port: 0,
      adminToken: randomBytes(32).toString("hex"),
      runnerToken: token,
      projects: this.projects,
      agents,
      conversationFile: conversation,
      memoryFile: memory,
      storeFile: path.join(data, "agentos.json"),
      projectsFile: path.join(data, "projects.local.json"),
      contactsFile: path.join(ownConfig, "contacts.local.json"),
      contactChannelsFile: path.join(data, "contacts-disabled.local.json"),
      knowledgeService: noKnowledge,
      feishuClient: localTransport,
      ...this.options.coreOverrides,
      retention: { enabled: true, days: 30, intervalMs: 3600000 },
    });
    const { recoverLocalExecutions } = await import(
      "../src/runner/local-executions.js"
    );
    await recoverLocalExecutions(
      this.core.store,
      path.join(data, "local-executions"),
    );
    await new Promise((r) => this.core.server.listen(0, "127.0.0.1", r));
    const { runnerConfig } = await import("../src/runner/config.js"),
      { createRunnerPool } = await import("../src/runner/index.js");
    const rc = await runnerConfig({
      serverUrl: `http://127.0.0.1:${this.core.server.address().port}`,
      runnerToken: token,
      projects: this.projects.projects,
      dataDir: data,
      worktreeRoot: path.join(data, "worktrees"),
      localExecutionRegistry: path.join(data, "local-executions"),
      executor: "codex",
      concurrency: c.runnerConcurrency ?? 3,
    });
    this.runners =
      this.options.startRunners === false ? [] : createRunnerPool(rc);
    this.running = Promise.all(this.runners.map((r) => r.start()));
  }
  bind(t) {
    this.projects.chatProjectMap["web_" + t.id] = t.projectId;
  }
  async submit(topic, message) {
    this.bind(topic);
    const chatId = "web_" + topic.id,
      profile = this.profile;
    const turn = await this.core.store.transact((s) => {
      s.questions ??= {};
      s.conversations ??= [];
      const exists = s.conversations.find(
        (t) => t.messageId === "web_" + message.id,
      );
      if (exists) return exists;
      // A private Web topic is one engine question; collaborators retain their own verified actor IDs.
      s.questions ??= {};
      s.conversations ??= [];
      const qid = "WEBQ-" + topic.id;
      const turn = {
        id: createId("CHAT"),
        messageId: "web_" + message.id,
        chatId,
        senderId: message.senderId,
        profile,
        role: "owner_intake",
        chatType: "group",
        projectId: topic.projectId,
        parentId: null,
        questionId: qid,
        content: message.text,
        attachments: message.attachments ?? [],
        attachmentErrors: [],
        cloudFileLinks: [],
        status: "queued",
        createdAt: message.at,
        sessionKey: JSON.stringify([
          chatId,
          message.senderId,
          profile,
          "owner_intake",
          topic.projectId,
        ]),
      };
      const q = s.questions[qid] ?? {
        id: qid,
        rootTurnId: turn.id,
        messageId: turn.messageId,
        chatId,
        threadRootId: turn.messageId,
        projectId: topic.projectId,
        profile,
        senderId: topic.ownerId,
        createdAt: turn.createdAt,
        title: topic.title,
        generation: 0,
      };
      q.latestTurnId = turn.id;
      q.generation++;
      s.questions[qid] = q;
      s.conversations.push(turn);
      return turn;
    });
    this.core.conversations.wake();
    return turn.id;
  }
  async snapshot(topic) {
    const s = await this.core.store.read(),
      chatId = "web_" + topic.id;
    const turns = s.conversations.filter((t) => t.chatId === chatId),
      jobs = s.jobs.filter((j) => j.chatId === chatId);
    const responses = [];
    for (const t of turns) {
      if (t.response && !t.outcome?.jobId && !t.outcome?.nextJobId)
        responses.push({
          id: t.id,
          kind: "assistant",
          text: t.response,
          at: t.completedAt ?? t.createdAt,
          status: t.aiFailed || t.actionError ? "failed" : "completed",
        });
    }
    for (const j of jobs)
      if (j.result?.finalMessage)
        responses.push({
          id: j.id + ":" + (j.updatedAt ?? j.createdAt),
          kind: "assistant",
          text: j.result.finalMessage,
          at: j.updatedAt ?? j.createdAt,
          status: j.status,
          jobId: j.id,
        });
    const turn = turns.at(-1),
      job = jobs.at(-1),
      active =
        job &&
        [
          "queued",
          "running",
          "cancelling",
          "awaiting_clarification",
          "awaiting_approval",
          "awaiting_environment_approval",
        ].includes(job.status);
    const pending =
      turn && ["queued", "thinking", "decided", "ready"].includes(turn.status);
    let status = pending
      ? "running"
      : active
        ? job.status
        : turn?.aiFailed || turn?.actionError
          ? "failed"
          : (job?.status ??
            (turn?.aiFailed || turn?.actionError
              ? "failed"
              : turn?.status === "sent"
                ? "completed"
                : (turn?.status ?? "queued")));
    if (["thinking", "decided", "ready"].includes(status)) status = "running";
    const event = job?.events?.filter((e) => e.type === "progress").at(-1);
    const files = [];
    if (job?.status === "completed" && job.result?.outcome === "ready")
      for (const source of jobs)
        for (const item of source.reportFiles ?? []) {
          if (
            item.questionGeneration ===
              s.questions?.[job.questionId]?.generation &&
            reportEligible(job.reportReviews ? job : source, item)
          ) {
            try {
              const verifiedKey = JSON.stringify([
                item.id,
                item.sha256,
                item.verificationHash,
              ]);
              if (!this.verifiedOutputs.has(verifiedKey)) {
                await reportFile(
                  this.core.config.dataDir,
                  item.sourceJobId ?? source.id,
                  item,
                  { includeContent: false },
                );
                this.verifiedOutputs.add(verifiedKey);
              }
              files.push({
                id: item.id,
                name: item.filename,
                bytes: item.bytes,
                sourceJobId: item.sourceJobId ?? source.id,
                item,
              });
            } catch {}
          }
        }
    for (const t of turns)
      if (t.outcome?.contactImage) {
        try {
          files.push({
            id: "contact-" + t.id,
            name: "联系人资料.png",
            bytes: t.outcome.contactImage.bytes,
            sourceTurnId: t.id,
            kind: "contact",
          });
        } catch {}
      }
    return {
      status,
      messages: responses,
      progress:
        event?.activity?.current ??
        (turn?.connectionWillRetry ? "正在恢复 AI 服务连接" : null),
      jobId: job?.id,
      files,
    };
  }
  async output(file) {
    if (file.kind === "contact") {
      const state = await this.core.store.read(),
        turn = state.conversations.find((t) => t.id === file.sourceTurnId);
      if (!turn?.outcome?.contactImage) throw new Error("联系人图片不可用");
      return this.core.conversations.context.contacts.validateImage(
        turn,
        turn.outcome.contactImage,
      );
    }
    return (
      await reportFile(this.core.config.dataDir, file.sourceJobId, file.item, {
        includeContent: false,
      })
    ).file;
  }
  async stop() {
    if (!this.core) return;
    const s = await this.core.store.read();
    if (
      (s.jobs ?? []).some((j) =>
        ["queued", "running", "cancelling"].includes(j.status),
      ) ||
      (s.conversations ?? []).some((t) =>
        ["queued", "thinking", "decided", "ready"].includes(t.status),
      )
    )
      return false;
    for (const r of this.runners) r.stop();
    await this.core.conversations.stop();
    await this.core.retention.close();
    await this.core.cards.stop();
    await new Promise((r) => this.core.server.close(r));
    await this.running;
    return true;
  }
}
