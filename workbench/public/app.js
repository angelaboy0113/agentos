const paths = {
  logo: "M4 24 15 4l11 20M9 17h12M12 22l3-6 3 6",
  plus: "M12 5v14M5 12h14",
  chat: "M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 2-2",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  at: "M16 8v6a3 3 0 0 0 6 0v-2a10 10 0 1 0-5 9M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  file: "M6 3h8l5 5v13H6V3M14 3v6h5M9 13h7M9 17h7",
  all: "M4 5h16M4 12h16M4 19h16M8 3v18",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10M12 14v3",
  send: "M12 20V4M5 11l7-7 7 7",
  clip: "m8 12 6-6a4 4 0 1 1 6 6L9 23a6 6 0 1 1-8-8L12 4",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M16 11h6",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  down: "M12 3v12M7 10l5 5 5-5M4 17v4h16v-4",
  copy: "M8 8h13v13H8V8M16 4H4v12",
  close: "m6 6 12 12M18 6 6 18",
  menu: "M4 6h16M4 12h16M4 18h16",
  arrow: "m9 5 7 7-7 7",
  logout: "M9 4H4v16h5M10 12h11M17 8l4 4-4 4",
  check: "m5 12 4 4L20 5",
};
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", name === "logo" ? "0 0 30 30" : "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", paths[name] ?? paths.chat);
  svg.append(p);
  return svg;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const append = (p, ...children) => {
  for (const c of children.flat().filter(Boolean)) p.append(c);
  return p;
};
const btn = (label, cls, fn, ico) => {
  const b = el("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  if (ico) b.append(icon(ico));
  if (label && !cls.split(" ").includes("icon-btn") && cls !== "send")
    b.append(el("span", "", label));
  if (fn) b.onclick = fn;
  return b;
};
const $ = (s) => document.querySelector(s),
  root = $("#app"),
  dialog = $("#modal");
let me,
  csrf,
  mode,
  projects = [],
  notify = false,
  current = null,
  scope = "mine",
  page = "chat",
  topics = [],
  draftFiles = [],
  pollBusy = false,
  lastDigest = "",
  topicData = null,
  requestId = crypto.randomUUID(),
  search = "",
  uploading = 0;
const time = (x) =>
  new Date(x).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const size = (x) =>
  x > 1048576
    ? (x / 1048576).toFixed(1) + " MB"
    : x > 1024
      ? (x / 1024).toFixed(1) + " KB"
      : x + " B";
const labels = {
  queued: "排队中",
  running: "处理中",
  completed: "已完成",
  blocked: "任务受阻",
  failed: "执行失败",
  cancelled: "已取消",
  awaiting_clarification: "等待补充",
  awaiting_approval: "等待确认",
  awaiting_environment_approval: "等待授权",
  cancelling: "正在停止",
};
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = "none"), 3600);
}
async function api(route, options = {}) {
  const headers = {
    ...(options.method && options.method !== "GET"
      ? { "x-csrf-token": csrf }
      : {}),
    ...options.headers,
  };
  if (
    options.body &&
    typeof options.body !== "string" &&
    !(options.body instanceof Blob)
  ) {
    headers["content-type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const r = await fetch(route, { ...options, headers });
  if (!r.ok) {
    let err;
    try {
      err = await r.json();
    } catch {}
    if (r.status === 401) {
      await boot();
    }
    throw new Error(err?.error ?? "请求暂未完成，请稍后重试");
  }
  return r.json();
}
function avatar(name) {
  return el("span", "avatar", Array.from(name ?? "成员")[0]);
}
function modal(title, subtitle) {
  const box = $("#modal-body");
  box.replaceChildren();
  const head = el("div", "modal-head");
  append(
    head,
    el("h2", "", title),
    btn("关闭", "icon-btn", () => dialog.close(), "close"),
  );
  box.append(head);
  if (subtitle) box.append(el("p", "", subtitle));
  if (!dialog.open) dialog.showModal();
  return box;
}
async function boot() {
  const info = await api("/api/me");
  me = info.user;
  csrf = info.csrf;
  mode = info.mode;
  projects = info.projects;
  notify = info.notificationsEnabled;
  if (!me && mode === "preview") {
    await api("/api/preview-login", {
      method: "POST",
      body: { id: "preview-owner" },
    });
    return boot();
  }
  if (!me) {
    renderLogin();
    return;
  }
  current = new URL(location.href).searchParams.get("topic");
  renderShell();
  await loadTopics();
  if (current) await openTopic(current);
  else renderWelcome();
}
function renderLogin() {
  const panel = el("main", "login"),
    inner = el("div", "login-inner");
  const brand = el("div", "brand");
  append(brand, icon("logo"), el("span", "", "AgentOS"));
  append(
    inner,
    brand,
    el("h1", "", "把问题留在自己的工作台"),
    el(
      "p",
      "",
      "提问、查看处理进度、下载文件。\n需要协作时，再邀请同事加入当前话题。",
    ),
    btn("使用飞书账号登录", "primary", () => (location.href = "/auth/login")),
    el("small", "", "话题仅对你、受邀成员和系统负责人可见。"),
  );
  panel.append(inner);
  root.replaceChildren(panel);
}
function renderShell() {
  root.replaceChildren();
  const shell = el("div", "shell"),
    side = el("aside", "sidebar"),
    brand = el("div", "brand");
  append(brand, icon("logo"), el("span", "", "AgentOS"));
  append(side, brand, btn("新对话", "new", newTopic, "plus"));
  const nav = el("nav", "nav");
  const entries = [
    ["我的对话", "chat", "mine", "chat"],
    ["@ 提到我", "list", "mentions", "at"],
    ["我的文件", "files", "files", "file"],
    ...(me.owner ? [["全部对话", "list", "all", "all"]] : []),
  ];
  for (const [text, p, s, i] of entries) {
    const b = btn(
      text,
      "",
      async () => {
        page = p;
        scope = s;
        current = null;
        draftFiles = [];
        history.replaceState(null, "", "/");
        $(".shell").classList.remove("menu-open");
        setNav();
        if (p === "chat") renderWelcome();
        else if (p === "files") await renderFiles();
        else await renderList();
      },
      i,
    );
    b.dataset.scope = s;
    nav.append(b);
  }
  side.append(nav);
  const hh = el("div", "history-head");
  append(hh, el("span", "", "最近对话"), el("span", "", "私有"));
  append(side, hh, el("div", "history"));
  const profile = el("div", "sidebar-bottom"),
    pt = el("div", "profile-text");
  append(
    pt,
    el("div", "", me.name),
    el("small", "", me.owner ? "系统负责人" : "企业成员"),
  );
  append(
    profile,
    avatar(me.name),
    pt,
    btn(
      mode === "preview" ? "切换体验身份" : "退出登录",
      "icon-btn",
      async () => {
        if (mode === "preview") return switchIdentity();
        await api("/auth/logout", { method: "POST" });
        location.href = "/";
      },
      "logout",
    ),
  );
  side.append(profile);
  const main = el("main", "main"),
    top = el("header", "topbar"),
    tg = el("div", "title-group");
  append(tg, el("h1", "", "私有工作台"), privacy());
  const actions = el("div", "top-actions"),
    n = el("span", "notice-pill");
  append(
    n,
    icon("bell"),
    el("span", "", notify ? "飞书提醒已开启" : "飞书提醒待接入"),
  );
  const invite = btn("邀请同事", "subtle-btn", () => inviteDialog(), "users");
  invite.querySelector("span").className = "invite-label";
  append(actions, n, el("div", "members-inline"), invite);
  append(
    top,
    btn(
      "打开侧栏",
      "icon-btn mobile-menu",
      () => shell.classList.toggle("menu-open"),
      "menu",
    ),
    tg,
    actions,
  );
  main.append(top);
  if (mode === "preview") {
    const banner = el("div", "preview-banner");
    append(
      banner,
      el("strong", "", "界面体验 · 未连接业务系统，不读取 PRD 数据"),
      btn("切换体验身份", "", switchIdentity),
    );
    main.append(banner);
  }
  main.append(el("section", "conversation"));
  const cw = el("footer", "composer-wrap"),
    composer = el("form", "composer");
  const input = el("textarea");
  input.placeholder = "向 AgentOS 提问，或输入 @ 邀请同事参与…";
  input.setAttribute("aria-label", "输入问题");
  input.rows = 2;
  input.onkeydown = (e) => {
    if (e.key === "@" && current) {
      e.preventDefault();
      inviteDialog();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  };
  const tray = el("div", "upload-tray"),
    bottom = el("div", "composer-bottom"),
    select = el("select");
  select.setAttribute("aria-label", "选择项目");
  for (const p of projects) {
    const o = el("option", "", p.name);
    o.value = p.id;
    select.append(o);
  }
  select.onchange = () => {
    if (current && select.value !== topicData?.topic.projectId) {
      toast("当前话题的项目保持不变；请新建对话选择项目");
      select.value = topicData.topic.projectId;
    }
  };
  const file = el("input");
  file.type = "file";
  file.multiple = true;
  file.hidden = true;
  file.id = "file-upload";
  file.onchange = async () => {
    await uploadFiles([...file.files]);
    file.value = "";
  };
  append(
    bottom,
    btn("添加附件", "icon-btn", () => file.click(), "clip"),
    btn("邀请同事", "icon-btn", () => inviteDialog(), "at"),
    select,
    btn("发送问题", "send", send, "send"),
  );
  append(composer, tray, input, bottom, file);
  composer.onsubmit = (e) => {
    e.preventDefault();
    send();
  };
  const hint = el("div", "hint");
  append(
    hint,
    icon("lock"),
    el("span", "", "话题对你、受邀成员及系统负责人可见"),
  );
  append(cw, composer, hint);
  main.append(cw);
  append(shell, side, main);
  root.append(shell);
  setNav();
}
function privacy() {
  const p = el("div", "privacy");
  append(p, icon("lock"), el("span", "", "仅你、受邀成员及系统负责人可见"));
  return p;
}
function setNav() {
  document
    .querySelectorAll(".nav button")
    .forEach((b) => b.classList.toggle("selected", b.dataset.scope === scope));
}
async function loadTopics() {
  const data = await api("/api/topics?scope=mine");
  topics = data.topics;
  const box = $(".history");
  if (!box) return;
  box.replaceChildren();
  if (!topics.length) box.append(el("div", "empty", "从一个问题开始"));
  for (const t of topics) {
    const b = btn(t.title, "", () => openTopic(t.id), "chat");
    b.classList.toggle("active", t.id === current);
    box.append(b);
  }
}
function renderWelcome() {
  page = "chat";
  scope = "mine";
  setNav();
  $(".title-group h1").textContent = "私有工作台";
  $(".members-inline").replaceChildren();
  const inner = el("div", "chat-inner"),
    welcome = el("div", "welcome"),
    mark = el("div", "welcome-symbol");
  mark.append(icon("logo"));
  append(
    welcome,
    mark,
    el("h2", "", "今天，有什么需要一起解决？"),
    el("p", "", "查数据、排问题、整理报表，都可以从这里开始。"),
  );
  const suggestions = el("div", "suggestions");
  for (const t of ["查询业务数据", "排查页面问题", "整理文件与报表"])
    suggestions.append(
      btn(t, "", () => {
        $("textarea").value = t + "：";
        $("textarea").focus();
      }),
    );
  welcome.append(suggestions);
  append(inner, welcome);
  $(".conversation").replaceChildren(inner);
  $(".composer-wrap").hidden = false;
}
async function newTopic() {
  if (
    draftFiles.length &&
    !confirm("新建对话后，当前已上传附件仍保留在原话题，是否继续？")
  )
    return;
  current = null;
  draftFiles = [];
  requestId = crypto.randomUUID();
  $(".upload-tray")?.replaceChildren();
  page = "chat";
  history.replaceState(null, "", "/");
  await loadTopics();
  renderWelcome();
  $("textarea").value = "";
  $("textarea").focus();
}
async function ensureTopic() {
  if (current) return current;
  const d = await api("/api/topics", {
    method: "POST",
    body: { projectId: $(".composer select").value },
  });
  current = d.topic.id;
  history.replaceState(null, "", "/?topic=" + current);
  return current;
}
async function openTopic(id) {
  try {
    current = id;
    page = "chat";
    lastDigest = "";
    draftFiles = [];
    $(".upload-tray").replaceChildren();
    $(".composer-wrap").hidden = false;
    const d = await api("/api/topics/" + id);
    topicData = d;
    history.replaceState(null, "", "/?topic=" + id);
    renderTopic(d, true);
    await loadTopics();
  } catch (e) {
    current = null;
    toast(e.message);
    renderWelcome();
  }
}
function renderTopic(d, force = false) {
  topicData = d;
  const digest = JSON.stringify(d);
  if (!force && digest === lastDigest) return;
  lastDigest = digest;
  $(".title-group h1").textContent = d.topic.title;
  $(".composer select").value = d.topic.projectId;
  $(".members-inline").replaceChildren(
    ...d.topic.participants.slice(0, 4).map((p) => {
      const a = avatar(p.name);
      a.title = p.name + " · " + p.role;
      return a;
    }),
  );
  const c = $(".conversation"),
    stay = c.scrollHeight - c.scrollTop - c.clientHeight < 100,
    inner = el("div", "chat-inner");
  if (d.topic.ownerId !== me.id && me.owner)
    inner.append(
      el(
        "div",
        "chat-section-note",
        "负责人视图 · 正在查看 " + d.topic.ownerName + " 发起的话题",
      ),
    );
  for (const m of d.messages) {
    const msg = el(
      "article",
      "message " + (m.kind === "user" ? "user" : "assistant"),
    );
    if (m.kind === "user") {
      const bubble = el("div", "bubble", m.text);
      append(
        bubble,
        el("div", "message-time", (m.senderName ?? "成员") + "  " + time(m.at)),
      );
      msg.append(bubble);
    } else {
      const mark = el("div", "agent-mark");
      mark.append(icon("logo"));
      const b = el("div", "assistant-body"),
        name = el("div", "agent-name");
      append(
        name,
        el("strong", "", "AgentOS"),
        el("span", "", time(m.at)),
        m.status && m.status !== "completed"
          ? el("span", "", labels[m.status] ?? "回复")
          : null,
      );
      const prose = el("div", "prose");
      renderMarkdown(prose, m.text);
      const tools = el("div", "message-tools");
      tools.append(
        btn(
          "复制回答",
          "icon-btn",
          async () => {
            await navigator.clipboard.writeText(m.text);
            toast("已复制回答");
          },
          "copy",
        ),
      );
      append(b, name, prose, tools);
      append(msg, mark, b);
    }
    inner.append(msg);
    for (const f of m.attachments ?? []) inner.append(fileTile(f, d.topic.id));
  }
  if (["queued", "running", "cancelling"].includes(d.topic.status)) {
    const p = el("div", "progress-card"),
      h = el("strong");
    append(h, el("span", "pulse"), el("span", "", d.topic.statusLabel));
    append(
      p,
      h,
      el(
        "p",
        "",
        d.topic.progress ?? "OS 正在处理这个问题，结果会更新在这里。",
      ),
    );
    inner.append(p);
  } else if (
    [
      "failed",
      "blocked",
      "awaiting_clarification",
      "awaiting_approval",
      "awaiting_environment_approval",
    ].includes(d.topic.status)
  ) {
    const p = el("div", "progress-card");
    append(
      p,
      el("strong", "warn", d.topic.statusLabel),
      el(
        "p",
        "",
        d.topic.progress ?? "请查看上方实际结果，可在此补充说明继续。",
      ),
    );
    inner.append(p);
  }
  if (d.files.some((f) => f.kind === "output"))
    inner.append(
      el("div", "chat-section-note", "已交付文件（含本话题历史版本）"),
    );
  for (const f of d.files.filter((f) => f.kind === "output"))
    inner.append(fileTile(f, d.topic.id));
  c.replaceChildren(inner);
  if (stay || force) c.scrollTop = c.scrollHeight;
}
function inline(parent, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const p of parts) {
    if (p.startsWith("**") && p.endsWith("**"))
      parent.append(el("strong", "", p.slice(2, -2)));
    else if (p.startsWith("`") && p.endsWith("`"))
      parent.append(el("code", "", p.slice(1, -1)));
    else parent.append(document.createTextNode(p));
  }
}
function renderMarkdown(parent, text) {
  const lines = String(text).split("\n");
  let code = null,
    list = null;
  const cells = (line) =>
    line
      .replace(/^\s*\||\|\s*$/g, "")
      .split("|")
      .map((x) => x.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      list = null;
      if (code) {
        parent.append(code);
        code = null;
      } else code = el("pre");
      continue;
    }
    if (code) {
      code.textContent += line + "\n";
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])
    ) {
      list = null;
      const wrap = el("div", "table-wrap"),
        table = el("table"),
        head = el("thead"),
        row = el("tr");
      for (const cell of cells(line)) {
        const th = el("th");
        inline(th, cell);
        row.append(th);
      }
      head.append(row);
      table.append(head);
      i++;
      const tbody = el("tbody");
      while (i + 1 < lines.length && lines[i + 1].includes("|")) {
        const tr = el("tr");
        for (const cell of cells(lines[++i])) {
          const td = el("td");
          inline(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      parent.append(wrap);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) {
        list = el("ul");
        parent.append(list);
      }
      const li = el("li");
      inline(li, line.replace(/^\s*[-*]\s+/, ""));
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+/.test(line),
      p = el(heading ? "h3" : "p");
    inline(p, heading ? line.replace(/^#{1,6}\s+/, "") : line);
    parent.append(p);
  }
  if (code) parent.append(code);
}
function fileTile(f, id) {
  const tile = el("div", "file-tile"),
    i = el("div", "file-icon");
  i.append(icon("file"));
  const meta = el("div", "file-meta");
  append(meta, el("strong", "", f.name), el("small", "", size(f.bytes)));
  const actions = el("div", "file-actions");
  append(
    actions,
    btn("预览", "", () => previewFile(id, f)),
    btn("下载", "", () => download(id, f)),
  );
  return append(tile, i, meta, actions);
}
async function download(id, f) {
  const a = document.createElement("a");
  a.href = "/api/topics/" + id + "/files/" + f.id;
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
}
async function previewFile(id, f) {
  try {
    const r = await fetch("/api/topics/" + id + "/files/" + f.id);
    if (!r.ok) throw new Error("文件暂时无法读取");
    const blob = await r.blob(),
      box = modal(f.name, size(f.bytes));
    if (/\.(png|jpeg|jpg|webp|gif)$/i.test(f.name)) {
      const image = el("img", "preview-image");
      image.src = URL.createObjectURL(blob);
      image.alt = f.name;
      box.append(image);
      dialog.addEventListener("close", () => URL.revokeObjectURL(image.src), {
        once: true,
      });
    } else if (/\.(csv|txt|md|json|log|tsv)$/i.test(f.name))
      box.append(el("pre", "preview-code", await blob.text()));
    else
      append(
        box,
        el("p", "", "此类型请下载后使用对应应用打开。"),
        btn("下载文件", "primary", () => download(id, f)),
      );
  } catch (e) {
    toast(e.message);
  }
}
async function uploadFiles(files) {
  if (!files.length) return;
  try {
    const id = await ensureTopic();
    for (const file of files) {
      uploading++;
      toast("正在上传 " + file.name);
      try {
        const r = await api("/api/topics/" + id + "/files", {
          method: "POST",
          body: file,
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
        });
        draftFiles.push(r.file);
        const chip = el("span", "", r.file.name + " · " + size(r.file.bytes));
        $(".upload-tray").append(chip);
      } finally {
        uploading--;
      }
    }
    await loadTopics();
    toast("附件已上传，发送问题时会一起提交");
  } catch (e) {
    toast(e.message);
  }
}
async function send() {
  const input = $("textarea");
  if (!input || !input.value.trim()) return;
  if (uploading) {
    toast("附件还在上传，请等待上传完成");
    return;
  }
  const button = $(".send");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const id = await ensureTopic();
    await api("/api/topics/" + id + "/messages", {
      method: "POST",
      body: {
        text: input.value,
        requestId,
        attachmentIds: draftFiles.map((f) => f.id),
      },
    });
    input.value = "";
    input.style.height = "auto";
    requestId = crypto.randomUUID();
    draftFiles = [];
    $(".upload-tray").replaceChildren();
    await openTopic(id);
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
}
async function renderList() {
  const all = scope === "all",
    inner = el("div", "list-view");
  append(
    inner,
    el("h2", "list-title", all ? "全部对话" : "@ 提到我"),
    el(
      "div",
      "list-subtitle",
      all
        ? "查看团队的问题、回答与处理进度，帮助完善 AgentOS。"
        : "受邀后，你可以在这里查看和参与对应话题。",
    ),
  );
  const input = el("input", "search-input");
  input.placeholder = all ? "搜索提问人、问题或回答" : "搜索受邀话题";
  input.value = search;
  input.setAttribute("aria-label", "搜索话题");
  const rows = el("div");
  input.oninput = () => {
    search = input.value;
    clearTimeout(input.timer);
    input.timer = setTimeout(() => fill(), 200);
  };
  append(inner, input, rows);
  $(".conversation").replaceChildren(inner);
  $(".composer-wrap").hidden = true;
  $(".title-group h1").textContent = all ? "团队工作台" : "协作话题";
  async function fill() {
    try {
      const data = await api(
        "/api/topics?scope=" + scope + "&q=" + encodeURIComponent(search),
      );
      rows.replaceChildren();
      const filtered = data.topics;
      for (const t of filtered) {
        const row = btn("", "topic-row", () => openTopic(t.id));
        const body = el("div", "row-details");
        append(
          body,
          el("strong", "", t.title),
          el(
            "small",
            "",
            t.ownerName +
              "  ·  " +
              time(t.updatedAt) +
              "  ·  " +
              (projects.find((p) => p.id === t.projectId)?.name ?? t.projectId),
          ),
        );
        append(
          row,
          icon("chat"),
          body,
          el(
            "span",
            "status " +
              (["failed", "blocked", "awaiting_clarification"].includes(
                t.status,
              )
                ? "wait"
                : ""),
            labels[t.status] ?? "处理中",
          ),
          icon("arrow"),
        );
        rows.append(row);
      }
      if (!filtered.length) rows.append(el("div", "empty", "这里还没有话题"));
    } catch (e) {
      toast(e.message);
    }
  }
  await fill();
}
async function renderFiles() {
  const inner = el("div", "list-view");
  append(
    inner,
    el("h2", "list-title", "我的文件"),
    el("div", "list-subtitle", "你有权访问的话题附件与交付文件。"),
  );
  const { files } = await api("/api/files");
  for (const f of files) inner.append(fileTile(f, f.topicId));
  if (!files.length)
    inner.append(
      el("div", "empty", "添加附件或完成导出后，文件会出现在这里。"),
    );
  $(".conversation").replaceChildren(inner);
  $(".composer-wrap").hidden = true;
  $(".title-group h1").textContent = "文件中心";
}
async function inviteDialog() {
  if (!current) {
    toast("先发送一个问题，再邀请同事参与");
    return;
  }
  const d = await api("/api/topics/" + current),
    box = modal("邀请同事参与", "只开放当前话题，其他对话仍然私有。");
  const note = el(
    "div",
    "modal-note",
    "加入后，可查看本话题的全部历史消息、回复和文件。系统负责人始终可查看。",
  );
  box.append(note);
  if (!d.topic.canManage) {
    box.append(el("p", "", "仅发起人和系统负责人可以邀请同事。"));
    return;
  }
  const input = el("input", "search-input");
  input.placeholder = "搜索已登录同事的姓名或工号";
  input.setAttribute("aria-label", "搜索同事");
  const rows = el("div");
  append(box, input, rows);
  async function fill() {
    try {
      const { people } = await api(
        "/api/people?q=" + encodeURIComponent(input.value),
      );
      rows.replaceChildren();
      for (const u of people) {
        const invited =
          d.topic.members.includes(u.id) ||
          d.topic.ownerId === u.id ||
          d.topic.participants.some(
            (p) => p.id === u.id && p.role === "系统负责人",
          );
        const row = el("div", "person-row"),
          name = el("div", "person-name");
        append(
          name,
          el("div", "", u.name),
          el("small", "", u.employeeNo ?? ""),
        );
        append(
          row,
          avatar(u.name),
          name,
          btn(invited ? "已可查看" : "邀请", "", async () => {
            const c = modal(
              "确认邀请 " + u.name,
              "此操作会向该同事开放当前话题的历史与后续内容。",
            );
            append(
              c,
              el(
                "div",
                "modal-note",
                "包括问题、全部回复和文件，不包括你的其他话题。",
              ),
            );
            const actions = el("div", "modal-actions");
            append(
              actions,
              btn("取消", "", () => dialog.close()),
              btn("确认邀请", "primary", async () => {
                try {
                  await api("/api/topics/" + current + "/members", {
                    method: "POST",
                    body: { userId: u.id },
                  });
                  dialog.close();
                  toast(
                    notify
                      ? "已邀请，飞书提醒已排队"
                      : "已邀请，可在“@ 提到我”中查看",
                  );
                  await refreshCurrent();
                } catch (e) {
                  toast(e.message);
                }
              }),
            );
            c.append(actions);
          }),
        );
        row.querySelector("button").disabled = invited;
        rows.append(row);
      }
      if (!people.length)
        rows.append(
          el("p", "", "暂未找到。对方需先使用企业飞书登录工作台一次。"),
        );
    } catch (e) {
      toast(e.message);
    }
  }
  input.oninput = () => {
    clearTimeout(input.timer);
    input.timer = setTimeout(fill, 200);
  };
  await fill();
}
async function switchIdentity() {
  const d = await api("/api/me"),
    box = modal(
      "切换体验身份",
      "仅本机体验模式提供，不用于正式登录或权限判断。",
    );
  for (const u of Object.values(d.previewUsers)) {
    const row = el("div", "person-row");
    append(
      row,
      avatar(u.name),
      el(
        "div",
        "person-name",
        u.name + (u.id === "preview-owner" ? " · 系统负责人" : ""),
      ),
      btn("切换", "", async () => {
        await api("/api/preview-login", { method: "POST", body: { id: u.id } });
        dialog.close();
        history.replaceState(null, "", "/");
        current = null;
        await boot();
      }),
    );
    box.append(row);
  }
}
async function refreshCurrent() {
  if (!current || page !== "chat" || pollBusy || dialog.open) return;
  pollBusy = true;
  try {
    const d = await api("/api/topics/" + current);
    renderTopic(d);
    $(".connection-note")?.remove();
  } catch (e) {
    if (!$(".connection-note"))
      $(".composer-wrap").prepend(
        el(
          "div",
          "connection-note",
          "连接暂时中断，正在重连；已提交的任务继续执行。",
        ),
      );
  } finally {
    pollBusy = false;
  }
}
window.addEventListener("popstate", () => {
  const id = new URL(location.href).searchParams.get("topic");
  if (id) openTopic(id);
  else {
    current = null;
    renderWelcome();
  }
});
setInterval(refreshCurrent, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCurrent();
});
boot().catch((e) => {
  root.replaceChildren(el("div", "empty", "工作台暂时无法连接：" + e.message));
});
