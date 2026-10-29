import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export class WorkbenchStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "workbench.json");
    this.queue = Promise.resolve();
  }
  async start() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dir)).isSymbolicLink())
      throw new Error("Workbench data directory cannot be a symlink");
    this.lock = await open(
      path.join(this.dir, ".owner.lock"),
      "wx",
      0o600,
    ).catch(() => {
      throw new Error(
        "Workbench data directory is already owned; inspect .owner.lock before recovery",
      );
    });
    await this.lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: now() }),
    );
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.state = {
        version: 1,
        topics: {},
        users: {},
        outbox: {},
        sessions: {},
        audit: [],
      };
    }
    return this;
  }
  async read() {
    await this.queue;
    return structuredClone(this.state);
  }
  tx(fn) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(this.state),
          r = await fn(next);
        const raw = JSON.stringify(next);
        if (raw !== JSON.stringify(this.state)) {
          const tmp = this.file + "." + uid() + ".tmp";
          await import("node:fs/promises").then((f) =>
            f.writeFile(tmp, raw, { mode: 0o600 }),
          );
          await rename(tmp, this.file);
          this.state = next;
        }
        return structuredClone(r);
      });
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async close() {
    await this.queue;
    await this.lock?.close();
    await rm(path.join(this.dir, ".owner.lock"), { force: true });
  }
}
export function canRead(topic, actor, config) {
  return Boolean(
    topic &&
      (topic.ownerId === actor.id ||
        config.ownerIds.includes(actor.id) ||
        topic.members.includes(actor.id)),
  );
}
export function requireTopic(state, id, actor, config) {
  const topic = state.topics[id];
  if (!canRead(topic, actor, config))
    throw Object.assign(new Error("话题不存在或无权访问"), { statusCode: 404 });
  return topic;
}
export function canManage(topic, actor, config) {
  return topic.ownerId === actor.id || config.ownerIds.includes(actor.id);
}
export function audit(s, actor, action, topicId) {
  const last = s.audit.findLast(
    (a) =>
      a.actorId === actor.id && a.action === action && a.topicId === topicId,
  );
  if (action === "view" && last && Date.now() - Date.parse(last.at) < 300000) {
    return;
  }
  s.audit.push({ at: now(), actorId: actor.id, action, topicId });
}
export function enqueueNotice(s, config, topic, kind, eventId, recipients) {
  if (!config.notifications.enabled) return;
  for (const recipient of new Set(recipients)) {
    if (!recipient) continue;
    const key = [topic.id, eventId, kind, recipient].join(":");
    s.outbox[key] ??= {
      id: uid(),
      topicId: topic.id,
      kind,
      recipient,
      eventId,
      status: "pending",
      createdAt: now(),
      attempts: 0,
    };
  }
}
export function topicSummary(t, s) {
  return {
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    ownerId: t.ownerId,
    ownerName: s.users[t.ownerId]?.name ?? "成员",
    members: t.members,
    status: t.status,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    messageCount: t.messages.length,
    unread: false,
  };
}
