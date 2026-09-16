import { databaseEndpoints } from "./config-endpoints.js";
const asset =
  /^\/nacos\/(?:console-ui\/public\/(?:js|css|img|fonts)\/|js\/|css\/|img\/|fonts\/)[A-Za-z0-9_./-]+\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)$/;
const metaPaths = new Set([
  "/nacos/v1/console/namespaces",
  "/nacos/v2/console/namespace/list",
  "/nacos/v1/console/server/state",
]);
export function browserRequestPolicy(
  baseUrl,
  namespaces,
  request,
  loggingIn = false,
) {
  let u;
  try {
    u = new URL(request.url);
  } catch {
    return "deny";
  }
  const base = new URL(baseUrl);
  if (
    u.origin !== base.origin ||
    u.username ||
    u.password ||
    /%2f|%5c|%2e|\\/i.test(u.pathname)
  )
    return "deny";
  const method = request.method.toUpperCase();
  if (
    method === "POST" &&
    ["/nacos/v1/auth/login", "/nacos/v1/auth/users/login"].includes(
      u.pathname,
    ) &&
    loggingIn &&
    !u.search
  )
    return "login";
  if (method !== "GET") return "deny";
  if (
    u.pathname === "/nacos/" ||
    u.pathname === "/nacos/index.html" ||
    asset.test(u.pathname)
  ) {
    if (
      [...u.searchParams.keys()].some(
        (k) => !/^[a-f0-9]{8,64}$/.test(k) && !["v", "version"].includes(k),
      )
    )
      return "deny";
    return "asset";
  }
  const allowedKeys = new Set(["accessToken", "username"]);
  if (metaPaths.has(u.pathname))
    return [...u.searchParams.keys()].every(
      (k) =>
        allowedKeys.has(k) ||
        (u.pathname.endsWith("/namespaces") && k === "namespaceId"),
    )
      ? "metadata"
      : "deny";
  if (
    !["/nacos/v1/cs/configs", "/nacos/v2/cs/history/configs"].includes(
      u.pathname,
    )
  )
    return "deny";
  for (const k of [
    "tenant",
    "namespaceId",
    "namespace",
    "search",
    "dataId",
    "group",
    "appName",
    "pageNo",
    "pageSize",
    "show",
    "config_tags",
    "types",
  ])
    allowedKeys.add(k);
  if ([...u.searchParams.keys()].some((k) => !allowedKeys.has(k)))
    return "deny";
  // Reject duplicate or conflicting namespace and mutation-shaped query switches.
  if (
    [...new Set(u.searchParams.keys())].some(
      (k) => u.searchParams.getAll(k).length > 1,
    )
  )
    return "deny";
  const scopeKeys = ["tenant", "namespaceId", "namespace"].filter((k) =>
    u.searchParams.has(k),
  );
  if (new Set(scopeKeys.map((k) => u.searchParams.get(k))).size > 1)
    return "deny";
  const namespace = scopeKeys.length ? u.searchParams.get(scopeKeys[0]) : "";
  if (!namespaces.includes(namespace)) return "deny";
  if (
    u.searchParams.has("show") &&
    !["all", ""].includes(u.searchParams.get("show"))
  )
    return "deny";
  if (
    u.searchParams.has("search") &&
    !["blur", "accurate"].includes(u.searchParams.get("search"))
  )
    return "deny";
  if (
    u.searchParams.has("pageSize") &&
    (!/^\d+$/.test(u.searchParams.get("pageSize")) ||
      Number(u.searchParams.get("pageSize")) > 100)
  )
    return "deny";
  return "config";
}
export function filterNacosResponse(path, body, namespaces, observations) {
  if (path.endsWith("/configs")) {
    const safeConfig = (text) => {
      let rows = [],
        partial = false;
      try {
        rows = databaseEndpoints(text);
        partial = rows.unresolved || rows.length === 0;
      } catch {
        partial = true;
      }
      observations.push({ rows: rows.slice(0, 20), partial });
      return JSON.stringify(
        {
          notice:
            "AgentOS只读视图：原配置正文已隐藏，仅显示数据库端点；不代表数据库连接成功",
          endpoints: rows.slice(0, 20),
          incomplete: partial,
        },
        null,
        2,
      );
    };
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return safeConfig(body);
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !["pageItems", "dataId", "content", "data", "code", "totalCount"].some(
        (k) => Object.hasOwn(parsed, k),
      )
    )
      return safeConfig(body);
    const safeKeys = new Set([
      "code",
      "message",
      "data",
      "pageItems",
      "totalCount",
      "pageNumber",
      "pagesAvailable",
      "id",
      "dataId",
      "group",
      "tenant",
      "namespace",
      "appName",
      "type",
      "content",
      "md5",
      "lastModified",
      "lastModifiedTs",
    ]);
    const walk = (v, depth = 0) => {
      if (depth > 12) return null;
      if (Array.isArray(v))
        return v.slice(0, 100).map((x) => walk(x, depth + 1));
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => safeKeys.has(k))
            .map(([k, x]) => [
              k,
              k === "message"
                ? ""
                : (k === "content" || k === "data") && typeof x === "string"
                  ? safeConfig(x)
                  : walk(x, depth + 1),
            ]),
        );
      return typeof v === "string" ? v.slice(0, 500) : v;
    };
    return JSON.stringify(walk(parsed));
  }
  if (path.includes("namespace")) {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed.data) ? parsed.data : [];
    return JSON.stringify({
      code: parsed.code,
      data: list
        .filter((x) => namespaces.includes(x.namespace))
        .map((x) => ({
          namespace: x.namespace,
          namespaceShowName: x.namespaceShowName,
          namespaceDesc: "",
          quota: x.quota,
          configCount: x.configCount,
          type: x.type,
        })),
    });
  }
  // Server state contains UI flags; never forward arbitrary server values.
  const p = JSON.parse(body);
  const flags = [
    "version",
    "auth_enabled",
    "login_page_enabled",
    "auth_system_type",
    "standalone_mode",
    "console_ui_enabled",
    "startup_mode",
    "function_mode",
  ];
  return JSON.stringify(
    Object.fromEntries(
      flags.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]]),
    ),
  );
}
export const unsafeControl =
  /创建|新建|编辑|修改|删除|发布|导入|导出|克隆|回滚|同步|授权|密码|注销|退出|新增|保存|确定|提交|create|edit|delete|publish|import|export|clone|rollback|sync|grant|password|logout|save|submit/i;
