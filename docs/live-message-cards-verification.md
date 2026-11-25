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
## 话题中分开发送附件

在原卡所属的飞书话题里，先单独发送图片或文件，再另发一条评论 @ 对应助手并说明怎么处理。助手会读取该发送者在本话题里上次 @ 本助手之后、本次 @ 之前发出的图片和文件。单独发附件不会启动本次跟进，其他成员的附件由上传者本人 @ 助手交给任务。

使用既有机器人身份、绑定群和话题资源读取权限，无需新增配置。验证时分别发送单独图片、单独文件，再各用一条文字评论 @ 助手，核对结果里只有附件中可见的内容。若无法读取，核对发送者和话题是否一致、原消息是否已撤回，以及机器人是否可以读取该话题历史和原始资源。
