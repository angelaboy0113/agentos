import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
export class PreviewAdapter {
  constructor(config) {
    this.config = config;
    this.outputs = new Map();
  }
  async start() {}
  async submit(t, m) {
    return m.id;
  }
  async snapshot(t) {
    const user = t.messages.filter((m) => m.kind === "user").at(-1);
    if (!user) return { status: "completed", messages: [], files: [] };
    const elapsed = Date.now() - Date.parse(user.at);
    if (elapsed < 1800)
      return {
        status: "running",
        messages: [],
        progress:
          elapsed < 900 ? "正在接收问题与附件" : "正在展示独立话题的处理进度",
        files: [],
      };
    const id = "preview-" + user.id,
      dir = path.join(this.config.dataDir, "preview-files", t.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, id + ".txt");
    await writeFile(
      file,
      "AgentOS 工作台体验文件\n这是合成演示，不包含业务数据，也没有执行 PRD 查询。\n",
      { mode: 0o600, flag: "wx" },
    ).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    this.outputs.set(id, file);
    return {
      status: "completed",
      messages: [
        {
          id,
          kind: "assistant",
          text: "已完成这次界面体验。\n\n你可以继续提问、添加附件，或邀请同事参与当前话题。这里展示的是独立工作台的交互流程，没有读取业务系统或执行真实查询。\n\n正式接入后，此处会显示 OS 的实际处理进度、回答及核验后的文件；飞书仅发送提醒和访问链接。",
          at: new Date(Date.parse(user.at) + 1800).toISOString(),
          status: "completed",
        },
      ],
      files: [
        {
          id,
          name: "工作台体验说明.txt",
          bytes: Buffer.byteLength(
            "AgentOS 工作台体验文件\n这是合成演示，不包含业务数据，也没有执行 PRD 查询。\n",
          ),
        },
      ],
    };
  }
  async output(file) {
    return this.outputs.get(file.id);
  }
  async stop() {
    return true;
  }
}
