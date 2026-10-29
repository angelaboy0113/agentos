import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OSAdapter } from "../os-adapter.js";
test("existing OS engine handles Web question and collaborator with isolated state/card transport and original actor authority", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-core-")),
    configDir = path.join(dir, "config");
  await mkdir(configDir);
  for (const [name, body] of Object.entries({
    "projects.local.json": {
      ownerOpenIdsByProfile: { owner: ["leader"] },
      projects: { demo: { displayName: "Test" } },
      chatProjectMap: { existing: "demo" },
    },
    "agents.local.json": {
      agents: {
        owner_intake: { profile: "owner" },
        developer: { profile: "dev" },
      },
    },
    "environments.local.json": { version: 1, environments: {} },
    "codex-runtime.local.json": {},
  }))
    await writeFile(path.join(configDir, name), JSON.stringify(body));
  const inputs = [];
  const adapter = new OSAdapter(
    {
      coreConfigDir: configDir,
      dataDir: path.join(dir, "web-data"),
      allowedProjectIds: ["demo"],
      notifications: { profile: "owner" },
    },
    {
      startRunners: false,
      coreOverrides: {
        conversationResponder: async (input) => {
          inputs.push(input);
          return input.message === "attempt-write"
            ? {
                action: "create_task",
                reply: "create",
                intent: "implementation",
                instruction: "implement sample",
                jobId: "",
                projectId: "demo",
                attachmentIds: [],
              }
            : {
                action: "reply",
                reply: "Echo " + input.message,
                intent: "none",
                instruction: "",
                jobId: "",
                projectId: "",
                attachmentIds: [],
              };
        },
      },
    },
  );
  const topic = {
    id: "private-test",
    ownerId: "member",
    projectId: "demo",
    title: "Synthetic topic",
  };
  await adapter.start({});
  t.after(async () => {
    await adapter.core.conversations.idle();
    await adapter.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await adapter.submit(topic, {
    id: "msg-one",
    senderId: "member",
    text: "private alpha",
    at: new Date().toISOString(),
  });
  await adapter.core.conversations.idle();
  for (let i = 0; i < 20; i++) {
    if ((await adapter.snapshot(topic)).messages.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(
    (await adapter.snapshot(topic)).messages.some((m) =>
      m.text.includes("private alpha"),
    ),
  );
  await adapter.submit(topic, {
    id: "msg-two",
    senderId: "collaborator",
    text: "private beta",
    at: new Date().toISOString(),
  });
  await adapter.core.conversations.idle();
  const state = await adapter.core.store.read();
  assert.equal(state.jobs.length, 0);
  assert.equal(new Set(state.conversations.map((t) => t.questionId)).size, 1);
  assert.equal(inputs.at(-1).currentActor.senderId, "collaborator");
  assert.equal(inputs.at(-1).administrator, false);
  assert.equal(inputs.at(-1).teamKnowledge.enabled, false);
  assert(inputs.at(-1).history.some((m) => m.user === "private alpha"));
  assert.equal(state.conversations.at(-1).status, "sent");
  assert.equal(adapter.projects.chatProjectMap.existing, undefined);
  assert(!adapter.core.config.dataDir.includes("/agentos/data"));
  assert(
    Object.values(state.cardMessages).every(
      (m) => !m.messageId || m.messageId.startsWith("web_"),
    ),
  );
  await adapter.submit(
    { ...topic, id: "another-private-topic" },
    {
      id: "msg-separate",
      senderId: "member",
      text: "separate",
      at: new Date().toISOString(),
    },
  );
  await adapter.core.conversations.idle();
  assert.equal(inputs.at(-1).history.length, 0);
  await adapter.submit(topic, {
    id: "msg-forbidden",
    senderId: "web-responsible-viewer",
    text: "attempt-write",
    at: new Date().toISOString(),
  });
  await adapter.core.conversations.idle();
  assert.equal(inputs.at(-1).administrator, false);
  assert.equal((await adapter.core.store.read()).jobs.length, 0);
  assert.equal((await adapter.snapshot(topic)).status, "failed");
  assert(
    process.env.AGENTOS_ENVIRONMENTS_FILE.startsWith(
      adapter.core.config.dataDir,
    ),
  );
  assert.deepEqual(
    JSON.parse(
      await import("node:fs/promises").then((f) =>
        f.readFile(path.join(configDir, "environments.local.json"), "utf8"),
      ),
    ),
    { version: 1, environments: {} },
  );
});
