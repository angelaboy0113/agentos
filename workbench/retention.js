import path from "node:path";
import { lstat, realpath, unlink } from "node:fs/promises";
// Keep the existing 30-day history rule, protect unfinished work and unsent reminders.
export async function pruneWorkbench(
  store,
  config,
  { now = Date.now(), days = 30 } = {},
) {
  const cutoff = now - days * 86400000;
  const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
  return store.tx(async (s) => {
    let topics = 0,
      files = 0;
    for (const t of Object.values(s.topics)) {
      if (
        !terminal.has(t.status) ||
        !Number.isFinite(Date.parse(t.updatedAt)) ||
        Date.parse(t.updatedAt) >= cutoff ||
        t.messages.some((m) => m.kind === "user" && m.dispatch !== "sent") ||
        Object.values(s.outbox).some(
          (n) => n.topicId === t.id && n.status === "pending",
        )
      )
        continue;
      for (const f of t.uploads) {
        const root = path.join(config.dataDir, "files", t.id),
          target = path.resolve(f.path ?? "");
        if (path.dirname(target) !== root) continue;
        try {
          if (
            (await lstat(root)).isSymbolicLink() ||
            (await lstat(target)).isSymbolicLink()
          )
            continue;
          const actual = await realpath(root);
          if (!(await realpath(target)).startsWith(actual + path.sep)) continue;
          await unlink(target);
          files++;
        } catch (e) {
          if (e.code !== "ENOENT") continue;
        }
      }
      delete s.topics[t.id];
      for (const [k, n] of Object.entries(s.outbox))
        if (n.topicId === t.id && n.status !== "pending") delete s.outbox[k];
      topics++;
    }
    for (const [key, session] of Object.entries(s.sessions))
      if (session.expires < now) delete s.sessions[key];
    s.audit = s.audit.filter(
      (a) =>
        Date.parse(a.lastViewedAt ?? a.at) >= cutoff || s.topics[a.topicId],
    );
    return { topics, files };
  });
}
