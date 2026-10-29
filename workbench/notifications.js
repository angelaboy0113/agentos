import { canRead } from "./store.js";
import { runLarkCli } from "../src/control-plane/lark-cli.js";
export class Notifications {
  constructor(store, config, send) {
    Object.assign(this, { store, config });
    this.send =
      send ??
      (async (entry, content) => {
        await runLarkCli(
          [
            "api",
            "POST",
            "/open-apis/im/v1/messages",
            "--as",
            "bot",
            "--params",
            JSON.stringify({ receive_id_type: "open_id" }),
            "--data",
            JSON.stringify({
              receive_id: entry.recipient,
              msg_type: "text",
              content: JSON.stringify({ text: content }),
              uuid: entry.id,
            }),
          ],
          {
            profile: config.notifications.profile,
            timeoutMs: 30000,
            cwd: store.dir,
          },
        );
      });
  }
  async tick() {
    if (this.busy || !this.config.notifications.enabled) return;
    this.busy = true;
    try {
      const s = await this.store.read();
      for (const e of Object.values(s.outbox).filter(
        (e) => e.status === "pending" && Date.now() >= (e.retryAt ?? 0),
      )) {
        const current = await this.store.read(),
          t = current.topics[e.topicId];
        if (!t || !canRead(t, { id: e.recipient }, this.config)) {
          await this.store.tx((s) => {
            s.outbox[
              Object.keys(s.outbox).find((k) => s.outbox[k].id === e.id)
            ].status = "revoked";
          });
          continue;
        }
        const labels = {
          question: "有成员提交了新问题",
          result: "话题有新的处理结果",
          mention: "有人邀请你参与话题",
        };
        const text = `AgentOS：${labels[e.kind] ?? "话题有更新"}。\n请登录工作台查看：${this.config.publicUrl}/?topic=${encodeURIComponent(t.id)}`;
        let error = false;
        try {
          await this.send(e, text);
        } catch {
          error = true;
        }
        await this.store.tx((s) => {
          const x = Object.values(s.outbox).find((x) => x.id === e.id);
          x.attempts++;
          if (error) {
            x.retryAt = Date.now() + Math.min(60000, x.attempts * 5000);
            x.error = "飞书提醒发送失败，等待重试";
          } else {
            x.status = "sent";
            x.sentAt = new Date().toISOString();
            delete x.error;
          }
        });
      }
    } finally {
      this.busy = false;
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick().catch(() => {}), 3000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
