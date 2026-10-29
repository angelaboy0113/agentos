import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const digest = (x) => createHash("sha256").update(x).digest("hex");
export function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim().split("="))
      .filter((a) => a.length === 2),
  );
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")),
    y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
export class Auth {
  constructor(store, config, { fetcher = fetch } = {}) {
    Object.assign(this, { store, config, fetcher });
    this.oauth = new Map();
  }
  cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config.mode === "live" ? "; Secure" : ""}`;
  }
  async createSession(user, res) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url");
    await this.store.tx((s) => {
      s.users[user.id] = { ...s.users[user.id], ...user };
      s.sessions[digest(token + this.config.sessionSecret)] = {
        userId: user.id,
        csrf,
        expires: Date.now() + 86400000,
      };
    });
    res.setHeader("set-cookie", this.cookie("aos_session", token, 86400));
    return { user, csrf };
  }
  async actor(req) {
    const token = cookies(req).aos_session;
    if (!token) return null;
    const s = await this.store.read(),
      session = s.sessions[digest(token + this.config.sessionSecret)];
    if (!session || session.expires < Date.now()) return null;
    const u = s.users[session.userId];
    return u ? { ...u, csrf: session.csrf } : null;
  }
  checkWrite(req, actor) {
    if (
      req.headers.origin !== this.config.publicUrl ||
      !safeEqual(req.headers["x-csrf-token"], actor.csrf)
    )
      throw Object.assign(new Error("请求来源或会话校验失败"), {
        statusCode: 403,
      });
  }
  start(res) {
    for (const [key, value] of this.oauth)
      if (value < Date.now()) this.oauth.delete(key);
    const state = randomBytes(32).toString("base64url");
    this.oauth.set(digest(state), Date.now() + 600000);
    res.setHeader("set-cookie", this.cookie("aos_oauth_state", state, 600));
    const url = new URL(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    url.searchParams.set("client_id", this.config.feishu.appId);
    url.searchParams.set(
      "redirect_uri",
      this.config.publicUrl + "/auth/callback",
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  }
  async callback(req, url, res) {
    const state = url.searchParams.get("state"),
      key = digest(state ?? ""),
      expiry = this.oauth.get(key);
    this.oauth.delete(key);
    if (
      !state ||
      !safeEqual(state, cookies(req).aos_oauth_state) ||
      !expiry ||
      expiry < Date.now()
    )
      throw Object.assign(new Error("登录校验已失效，请重新登录"), {
        statusCode: 401,
      });
    const code = url.searchParams.get("code");
    if (!code) throw new Error("飞书未返回登录授权码");
    const tokens = await this.fetcher(
      "https://accounts.feishu.cn/oauth/v3/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: this.config.feishu.appId,
          client_secret: this.config.feishu.appSecret,
          code,
          redirect_uri: this.config.publicUrl + "/auth/callback",
        }),
        signal: AbortSignal.timeout(30000),
      },
    ).then((r) => r.json());
    if (!tokens.access_token) throw new Error("飞书登录换取身份失败");
    const response = await this.fetcher(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: { authorization: "Bearer " + tokens.access_token },
        signal: AbortSignal.timeout(30000),
      },
    ).then((r) => r.json());
    const u = response.data;
    if (
      response.code !== 0 ||
      !/^ou_[A-Za-z0-9]+$/.test(u?.open_id ?? "") ||
      u.tenant_key !== this.config.feishu.tenantKey
    )
      throw Object.assign(new Error("请使用本企业飞书账号登录"), {
        statusCode: 403,
      });
    return this.createSession(
      {
        id: u.open_id,
        name: u.name ?? "成员",
        employeeNo: u.employee_no ?? "",
        tenantKey: u.tenant_key,
      },
      res,
    );
  }
  async logout(req, res) {
    const token = cookies(req).aos_session;
    if (token)
      await this.store.tx((s) => {
        delete s.sessions[digest(token + this.config.sessionSecret)];
      });
    res.setHeader("set-cookie", this.cookie("aos_session", "", 0));
  }
}
