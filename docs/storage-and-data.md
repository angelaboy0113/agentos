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
| `data/codex-conversations.json` | 可选群会话的持久线程引用、待定请求与最近决策；依赖本机 Codex 会话文件，0600，不是登录文件 | 是 | 否 |
| `data/memory.json` | 按范围的持久摘录摘要、来源指纹及停用记录；详见[记忆管理](memory-management.md) | 是 | 否 |
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

- 停止 AgentOS 后，至少备份 `data/agentos.json`、已有 `data/memory.json`、local 配置和仍需保留的 `data/worktrees/`。备份包含敏感信息，应加密并限制访问。
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

开启问题卡片后，`agentos.json` 新增 `questions` 元数据，新对话与新 Job 带 `questionId`；旧记录不回填。备份应包括已有 `codex-conversations.json` 与 `config/conversation.local.json`，详见[实现与恢复](group-question-cards.md)。

## 可选环境查询边界

详见[受控环境查询](environment-access.md)和[只读排查自动授权](read-only-auto-authorization.md)。环境配置仅存在 ignored 的 `config/environments.local.json`，凭据保存在当前 Mac 用户 Keychain。UAT/PRD 受控只读查询由策略自动授权，修改操作仍需管理员审批。查询结果归属原问题卡片，不注入共享长期记忆；真实环境验收须在本机配置后完成。

## 环境源码快照

可选 `analysisSourceMode=isolated`：以配置的项目根目录为来源，根据问题选择 `analysisEnvironments`，在 `analysisSnapshotRoot` 下创建独立同步快照。保留个人功能分支与未提交修改；环境未指定且无默认值时先询问，禁止回退 PRD。上文原目录快进同步规则仅适用于未启用此选项的兼容模式。每次调查与负责人汇总复用同一分支/提交证据，仍不能证明实际部署版本。配置、清理与验收见 [源码同步说明](source-sync.spec.md)。

## 按问题发现业务网站

支持从问题与环境源码查找入口，打开本机独立浏览器并复用会话；等待登录时保留任务、登录后自动恢复。配置、权限、存储与兼容边界见[通用网页排查](query-driven-websites.md)。
