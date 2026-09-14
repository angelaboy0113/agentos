# AgentOS 文件、数据与日志位置

本页回答“AgentOS 生成的东西都在哪里”。默认程序目录以下用 `<agentos>` 表示；默认运行数据根目录是 `<agentos>/data`，可用 `AGENTOS_DATA_DIR` 改到其他绝对路径。

快速查看本机实际路径和占用大小：

```powershell
.\scripts\show-storage.ps1
```

该脚本只显示路径、是否存在和大小，不读取或输出消息、凭据、日志正文。

## 项目目录内

| 位置 | 内容 | 是否敏感 | 是否进入 Git |
|---|---|---:|---:|
| `src/` | Control Plane、Runner、Codex 连接和持久化源码 | 否 | 是 |
| `config/*.example.json`、`config/roles/` | 可复制示例、角色规则和协议 schema | 脱敏后否 | 是 |
| `config/*.local.json` | 真实项目路径、群 ID、机器人/真人 ID、网络出口 | 是 | 否 |
| `.env` | 可选环境变量和令牌 | 严重敏感 | 否 |
| `docs/`、`scripts/`、`test/` | 设计、部署、维护、辅助脚本和回归测试 | 否 | 是 |
| `data/agentos.json` | Job、Mission、对话、AI 决策、状态、结果、发送和幂等记录 | 是 | 否 |
| `data/attachments/<JOB>/` | HTTPS/OpenAPI 接入下载的任务附件 | 是 | 否 |
| `data/lark-cli/` | lark-cli 消息资源下载工作目录 | 是 | 否 |
| `data/lark-cli-events/<profile>/messages/<messageId>/` | 长连接消息中的图片、文件、音频和媒体 | 是 | 否 |
| `data/lark-cli-events/<profile>/pending-card-actions/` | 尚未成功送达 Control Plane 的卡片回调重放文件 | 是 | 否 |
| `data/lark-cli-config/<profile>/config.json` | 为避免多个机器人争用而复制的 lark-cli profile 配置 | 严重敏感 | 否 |
| `data/worktrees/<JOB-stage>/` | 实施任务的隔离 Git worktree 与未提交业务改动 | 严重敏感 | 否 |
| `data/worktrees/analysis-resources/` | 只读分析任务下载的附件资源 | 是 | 否 |
| `data/logs/agentos.stdout.log`、`agentos.stderr.log` | Windows 登录后启动的标准输出和错误日志 | 是 | 否 |
| `data/card-updates.paused` | 暂停更新的飞书卡片 message_id 列表 | 是 | 否 |
| `data/smoke/`、`data/card-previews/` | 本地烟测和卡片预览输出 | 可能敏感 | 否 |

`data/agentos.json` 是默认唯一业务状态真源。它不是数据库，但包含真实消息和任务上下文；重启会继续读取它。对话会保存 `chatType`，任务会保存 `originProfile`、`originChatType`、原 `senderId` 和不可变的 `originMessageId`；卡片 outbox 还会保存终态提醒及 `mentionDelivered`，以便断网后只补发一次 `@`。不要上传到 GitHub、飞书文档或问题单。

## 项目目录外

| 位置 | 内容 | 注意事项 |
|---|---|---|
| 系统临时目录 `agentos-chat-<数据目录哈希>/` | 常驻只读聊天线程的工作目录 | 重启会重建线程；不要当长期状态或业务源码 |
| 当前用户 `~/.codex/` 或系统凭据库 | Codex 配置和登录缓存 | `auth.json` 等同密码，绝不提交或复制给陌生人 |
| 当前用户 `~/.lark-cli/` | lark-cli 原始 profile 与认证 | 运行时会复制到 `data/lark-cli-config/`，两处都敏感 |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\AngelAgentOS` | Windows 当前用户登录后启动项 | 不是系统服务，也不是 Codex 登录 |
| 业务仓库 `.git/worktrees/` 元数据 | 关联 `data/worktrees/` 中的工作树 | 清理工作树必须回到对应业务仓执行 Git worktree 命令 |

## 保存、备份与清理

- 停止 AgentOS 后，至少备份 `data/agentos.json` 和仍需保留的 `data/worktrees/`。备份包含敏感信息，应加密并限制访问。
- 不要在运行中手工编辑 `agentos.json`；写入采用临时文件加原子重命名，外部同时改写会破坏状态。
- 不要直接删除有未提交修改的 `data/worktrees/`。先在对应业务仓执行 `git status`，确认归属和保留方式，再使用 `git worktree remove <路径>`；必要时另行备份。
- `pending-card-actions/` 未清空表示仍有卡片动作等待送达；不能把删除文件当成“处理成功”。
- 系统临时聊天目录可在 AgentOS 完全停止后清理，但长期对话仍在 `agentos.json`；清理临时目录不会删除任务历史。
- 日志可能包含群、任务和路径信息。排障只截取必要、已脱敏片段。

## 什么能上传 GitHub

只上传源码、脱敏示例、设计文档、脚本和测试。发布前确认：

```powershell
git status --short
git check-ignore .env config\projects.local.json config\agents.local.json config\codex-runtime.local.json data\agentos.json
```

这些私有路径都应显示为 ignored。完整发布检查见根目录 `SECURITY.md`。
