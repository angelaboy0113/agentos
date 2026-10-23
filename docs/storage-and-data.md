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
| `data/knowledge/knowledge.sqlite` | 显式团队范围内的通用知识、版本、依赖指纹、索引与命中计数；不包含原始聊天。见[团队知识](team-knowledge.md) | 是 | 否 |
| `data/memory.json` | 按范围的持久摘录摘要、来源指纹及停用记录；详见[记忆管理](memory-management.md) | 是 | 否 |
| `data/agentos.json` | Job、Mission、对话、AI 决策、状态、结果、发送、幂等记录及最近 200 项本机设置审计 | 是 | 否 |
| `data/exports/<JOB>/` | 完整分组报表 CSV，含实时业务金额；通过文件校验后回复原提问。见[报表导出](report-exports.md) | 是 | 否 |
| `data/exports/<JOB>/report-*.verification.json` | 最终文件的列/覆盖/分量核验及业务依据，与CSV绑定；不等于人工业务验收 | 是 | 否 |
| `data/exports/<JOB>/datasets/` | 本任务完整数据集检查点，含范围指纹、取数时间和摘要；不完整集不保存，不进入团队知识。24小时后不再复用；启用历史保留策略后随过期任务清理 | 是 | 否 |
| `data/lark-cli/reports/` | CLI 文件回复副本，需与正式导出文件分别清理 | 是 | 否 |
| `data/website-evidence/<JOB>/` | 用户要求的当前网页视口截图，输入区遮挡；摘要校验后通过原话题投递，待发送保存在websiteEvidenceDeliveries，随问题保留策略清理 | 是 | 否 |
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

状态文件使用紧凑 JSON 和有界问题上下文。每个在途 Job 最多携带 8 项去重证据；已经交接的历史 Job 保留自身结果与事件，不再重复保存整条上下文。主卡只装载最近 6 项有效结果，避免长任务把卡片和每次状态事务拖慢。升级迁移只删除重复的上下文副本，不删除 Job 结果、事件或本机审计历史；迁移前仍应按下文要求停机备份。

## 项目目录外

| 位置 | 内容 | 注意事项 |
|---|---|---|
| 系统临时目录 `agentos-chat-<数据目录哈希>/` | 常驻只读聊天线程的工作目录 | 重启会重建线程；不要当长期状态或业务源码 |
| 当前用户 `~/.codex/` 或系统凭据库 | Codex 配置和登录缓存 | `auth.json` 等同密码，绝不提交或复制给陌生人 |
| macOS Keychain `com.angel.agentos.environment.<网站引用>` | 网站负责人回复等待登录卡片时提交的账号密码 | AgentOS 状态、卡片和日志只保存非敏感凭据引用；原始群消息仍按企业飞书留存策略保存 |
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

详见[受控环境查询](environment-access.md)和[只读排查自动授权](read-only-auto-authorization.md)。环境配置仅存在 ignored 的 `config/environments.local.json`，凭据保存在当前 Mac 用户 Keychain。UAT/PRD 受控只读查询由策略自动授权，修改操作仍需管理员审批。查询原始结果归属原问题卡片，不注入个人共享记忆；显式启用团队知识后，仅对完成且有证据的分析提炼不含具体案例数据的通用说明，独立保存。真实环境验收须在本机配置后完成。

通用网站等待登录时，只有该网站环境在当前机器人 profile 下配置的负责人可以直接回复对应任务卡提交账号密码。控制面用卡片或同一话题绑定具体网站，在普通对话入库之前消费凭据消息，不把正文写入 `data/agentos.json`；Keychain 保存后仅使用凭据引用。AgentOS 无法删除飞书服务端群消息，群成员可见范围和留存按企业飞书策略执行。固定登录脚本只在已批准网站 origin、应用路径或同源认证路径填写表单，验证码和 MFA 不保存也不绕过。详见[日常 Chrome 登录态复用](shared-chrome.md)。

## 环境源码快照

可选 `analysisSourceMode=isolated`：以配置的项目根目录为来源，根据问题选择 `analysisEnvironments`，在 `analysisSnapshotRoot` 下创建独立同步快照。保留个人功能分支与未提交修改；环境未指定且无默认值时先询问，禁止回退 PRD。上文原目录快进同步规则仅适用于未启用此选项的兼容模式。同一卡内的源码与工具步骤复用同一分支/提交证据，仍不能证明实际部署版本。配置、清理与验收见 [源码同步说明](source-sync.spec.md)。

## 按问题发现业务网站

支持从问题与环境源码查找入口，打开本机浏览器并复用会话；等待登录时保留任务、明确显示网站，可由负责人本机登录或回复任务卡提交 Keychain 凭据，登录后自动恢复。配置、权限、存储与兼容边界见[通用网页排查](query-driven-websites.md)。

## 联系人信息图

`data/contact-index/directory.sqlite`保存受范围/权限指纹限制的最小目录候选，不含手机号或邮箱；与团队知识SQLite分开。`data/contact-images/`保存个人资料PNG和校验回执，`data/lark-cli/images/`为CLI上传副本；对话outcome登记原提问范围与投递状态。文件含人员资料，使用本机受限权限，不进入Git或团队知识；停稳后备份；启用历史保留策略后清理过期本地图片与索引。配置和验收见[联系人信息图](contact-images.md)。

私有卡片的visibility、固定收件者、privateDeliveryKind及旧临时卡片清理队列随问题/任务和cardMessages存入原状态JSON；共享知识不自动接收私有调查。私有附件仍保存在原本地目录，私聊投递不代表本地管理员隔离。

## 本机控制请求回执

`data/agentos.json.controlReceipts`和`data/control-receipts/<请求编号>.json`共同保存关键状态提交的恢复依据；正文可能含任务证据，须私有保存、停机成套备份，不单独清空。详见[本机状态请求恢复](control-recovery.md)。

报表可选组合行键由完整分组字段（含null区别）计算，属于任务数据集，不进入共享知识。`jobs[].investigationProgress.toolCorrections`保存定向修复类别的去重摘要，随状态备份；不手工清空以规避无进展保护。部署无需新权限、依赖或数据库迁移。见[报表粒度与修复接续](report-grain-recovery.md)。

data/local-executions保存本机实际fork的父/工作进程和租约身份，随状态/回执/exports成套备份；不入Git或共享知识。进程存在、外机、旧无登记、Windows或无法证明整个进程组已退出时，不自动解除执行隔离。见[空值与本机异常退出恢复](local-executor-recovery.md)。

报表分卷临时副本位于`exports/<JOB>/.delivery-*`，正常完成/异常退出投递函数时清理；进程崩溃可能保留，确认无投递后可清理，不删除主报表或核验记录。`reportDeliveries.parts`保存每卷名称、字节、SHA-256与消息回执，不保存正文。详见[报表导出](report-exports.md)。

## 可选历史保留策略

独立多系统启动器默认保留30天；通用服务需设置 `AGENTOS_RETENTION_DAYS` 显式启用。启动及每日清理已结束且无在途交付依赖的过期问题、任务、索引、缓存和允许目录内的文件。活动/等待问题、配置凭据、源码和开发worktree不因达到30天被删除。并非整盘清理，飞书服务器与系统级Codex记录不受影响。完整目录、配置、失败与验收边界见[多系统说明：本地历史保留与自动释放](system-assistants.md#本地历史保留与自动释放)。
