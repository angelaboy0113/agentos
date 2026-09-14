# 动态消息卡片验证记录

2026-09-05，本地开发验证。

- `scripts/use-node22.ps1 npm run check`：39/39 通过（新增 8 项）。覆盖真实事件投影、敏感字段不外发、同卡更新、终态保护、并发更新串行化、持久化重试、幂等发送、长文本续文、普通对话完整处理链和任务通知链。
- `scripts/use-node22.ps1 node scripts/preview-message-cards.mjs`：Feishu CLI reply/原生 PATCH 两种请求 dry-run 均通过。此结果只证明请求可以构造，不代表飞书服务端已接受、手机渲染已验收。
- 飞书技能结构检查 P0–P7：原生 Card 2.0；主焦点为当前操作/阶段结论；2–5 块；单语义主色 + grey；12px 间距；weighted 栏；详情折叠；无虚假按钮。动态内容有长度上限，超过部分持久化续发。
- 19:07 左右确认 activeJobs=0、activeChats=0 后重启 AgentOS 专属进程，未停止其他项目或 Codex 桌面进程。旧日志备份在 `data/logs/before-live-cards-20260905-1910`。
- 19:08 健康接口返回 `messagePresentation=live-cards-v1`、`conversationTransport=app-server-stdio`、`conversationConcurrency=3`；新 Runner 为 `runner-win32-47264`，执行器 codex、心跳更新。
- 未更换模型、Codex 认证、项目绑定、角色权限、人工验收门。
- 尚未发送真实群聊预览；未将 dry-run 或测试替身计为真实群聊端到端验收。用户可测试普通问候，以及“梳理当前项目，不修改代码”来查看真实工具进度。

限制：不是逐 token 输出；命令参数和原始输出默认隐藏；目前不提供正在运行任务的卡片停止按钮。运行中任务仍需通过现有人工流程处理。

接口依据：
- https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md
- https://learn.chatgpt.com/docs/non-interactive-mode
