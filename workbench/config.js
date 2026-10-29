import path from "node:path";
import { readFile } from "node:fs/promises";
export async function loadConfig(file = process.env.AGENTOS_WORKBENCH_CONFIG) {
  const c = file ? JSON.parse(await readFile(path.resolve(file), "utf8")) : {};
  const mode = c.mode ?? "preview",
    host = c.host ?? "127.0.0.1";
  if (!["preview", "live"].includes(mode))
    throw new Error("mode must be preview or live");
  if (mode === "preview" && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("Preview is loopback only");
  const origin = new URL(c.publicUrl ?? `http://127.0.0.1:${c.port ?? 8790}`);
  if (mode === "live" && origin.protocol !== "https:")
    throw new Error("Live publicUrl requires HTTPS");
  const result = {
    ...c,
    mode,
    host,
    port: c.port ?? 8790,
    publicUrl: origin.origin,
    dataDir: path.resolve(c.dataDir ?? "./data/workbench"),
    ownerIds: c.ownerIds ?? [],
    allowedProjectIds: c.allowedProjectIds ?? [],
    notifications: { enabled: false, ...c.notifications },
    feishu: {
      ...c.feishu,
      appSecret:
        process.env.AGENTOS_WORKBENCH_APP_SECRET ?? c.feishu?.appSecret,
    },
    sessionSecret:
      process.env.AGENTOS_WORKBENCH_SESSION_SECRET ?? c.sessionSecret,
  };
  if (mode === "live") {
    if (
      !result.ownerIds.length ||
      !result.allowedProjectIds.length ||
      !result.feishu?.appId ||
      !result.feishu?.appSecret ||
      !result.feishu?.tenantKey ||
      !result.coreConfigDir ||
      !result.sessionSecret ||
      result.sessionSecret.length < 32
    )
      throw new Error(
        "Live requires ownerIds, allowedProjectIds, coreConfigDir, Feishu app/tenant and session secret",
      );
    if (!result.coreAppId || result.coreAppId !== result.feishu.appId)
      throw new Error(
        "OAuth and OS notification profile must use the same Feishu app ID",
      );
  }
  return result;
}
