# 多系统知识助手部署与迁移

程序版本 1.29.0，更新日期 2026-10-22；Node 22.13–22.x，依赖以 package-lock.json 为准。新实例须使用自己的专用分支和独立检出目录。本文不改变旧部署的配置或运维手册。

## 布局与启动

实例根目录含 `agentos/`（程序）、`systems/`（各系统规范总仓及微服务）、`runtime/`（私有配置、认证、快照、状态和日志）。真实路径、群 ID、应用 ID、群主 ID 在 ignored 的 `config/*.local.json` 或实例私有 runtime 中，不进公开 Git。

`projects.local.json` 中 `chatProfileProjectMap` 按群和机器人 profile 选择系统，`topicChatIds` 配置话题群。每个项目配置 `repoPath`、`assistantInstructionsFile`、`analysisSourceMode=isolated`、独立 `analysisSnapshotRoot` 和 `analysisEnvironments`。环境未指定不设置默认值。`analysisEnvironments.<环境>.unavailableRepositories` 记录远端环境分支缺失的仓库，查询相关范围时必须说明证据缺口，不拿其它分支替代。

`agents.local.json` 为各系统设置独立 profile、`systemAssistant=true`、`role=developer`、`projectId`、`allowedChatIds`。这是执行器内部角色，群里只展示各系统助手。系统助手只接受指定群内的 @ 消息，私聊及其它群消息在下载附件或进入对话前拒绝；私密导出投递不因此关闭。系统规范 MD 同时用于聊天和源码调查；写权限由程序管理员门禁核验。

先执行 `sh scripts/run-system-instance.sh --check`。只有机器人和本应用内群主身份、独立认证文件、源码目录全部就绪，才允许 `--start`。默认端口在私有 `runtime/instance.local.json` 配置，受保护端口禁止占用。启动器清除继承的 AgentOS/飞书实例变量，再显式设置独立 data、worktree、配置和 CLI 路径。新实例使用独立浏览器会话，不复用旧实例 Chrome 标签。

## 飞书接入

1. 为每个系统创建独立企业应用并启用机器人。配置所需消息/群信息/图片文件权限，提交企业审核；测试账户成功不代表全员可用。
2. 配置长连接事件 `im.message.receive_v1` 和长连接回调 `card.action.trigger`。权限申请、机器人发布和可用范围均逐应用核验。
3. 将新应用凭据写入本实例独立 CLI 配置目录。使用 `LARKSUITE_CLI_CONFIG_DIR=<实例>/runtime/lark-cli`，按 CLI 的 `config init --name <新profile> --app-id <新AppID> --app-secret-stdin` 配置；App Secret 通过本机隐藏输入送入 stdin，不能写在命令参数、聊天、日志或 Git。不得覆盖原 CLI 配置或降低 Keychain 安全设置。
4. 只将已经发布并入群的机器人放入当前生效的 `agents.local.json`；待审批的助手配置保存在实例私有待接入清单，不启动其事件消费者。批准后加入新群、将配置加入生效清单，再重新核验并仅重启新实例。发布后把新机器人加入新群，再运行 `node scripts/verify-system-bots.mjs`。脚本分别以新应用身份核验机器人和群主；同一个人在不同应用中的 open_id 不同，不能复制旧机器人的管理员 ID。
5. 通过预检后才启动；核对 `/health`、两个消息/回调消费者，以及新群中真实 @ 问答。

普通成员可查询测试和生产、分析文件和导出；数据库仍使用已有受控只读工具。管理员身份不是任意 SQL 写入工具已实现的证明，写入/部署请求仍受实际执行能力和审批边界约束。

项目 `environmentExportMaxRows` 可设置为 `all`，环境接入向导据此为新建的 MySQL 调查模板开放完整导出；预览仍只展示少量行，完整数据须通过已有数据集和导出校验。该字段不放宽所选库、表或只读限制。团队知识在独立 `knowledge.local.json` 按项目/群/profile 配置，通用规则与实时数据分开，跨系统不共享。

## 首次环境接入

数据库、Nacos、网站按系统和环境独立登记；不复制旧部署的真实连接、浏览器 Cookie 或凭据。用户提问未指定环境时 @ 询问。缺少入口时由群主提供对应环境 Nacos/网站入口并确认接入，使用现有向导、钥匙串和原卡恢复流程。已有网页账号密码可按任务卡的既有流程由指定负责人提供；验证码、扫码等仍需真人完成。

正式使用前核验：每个系统的测试与生产来源、普通成员只读问答、CSV完整导出、错 @ 提示重新提问、成员写操作拒绝、群主身份、登录等待与恢复、失败提示及原实例健康。合成测试不代替真实生产业务验收。

## 换电脑

新电脑准备 Node22、Git、lark-cli、Codex 登录、浏览器及内网/VPN/数据库白名单。先安装本实例相同分支和提交；业务仓可重新拉取。将私有配置中的旧实例根路径改为新路径，保留系统和分支映射。

在没有在途执行时停止旧实例，成套加密备份 runtime/data（任务、记忆、知识、回执、附件、导出）、私有配置和需保留的改动。不复制旧机器进程 PID/租约来认领执行，也不承诺 Codex thread 引用跨机即可恢复；跨机待续任务需专门核验。保持历史证据原文，后续源码调查重新获取当前远端快照。

新电脑重新配置 CLI/Codex 登录、Keychain 和浏览器会话；迁移后检查路径、群主、权限及网络。先停旧事件消费者再让新实例接管；验收前保留回退备份。不要让两机写同一个状态目录。

macOS 网页交互依赖登录的桌面用户；专用 Mac mini 可通过远程桌面维护，但重启登录和 MFA 仍要安排。新实例如配置自启动，必须使用独立 LaunchAgent 名称（例如 com.agentos.knowledge），不能执行旧的固定 com.agentos.local 安装脚本。服务配置保存在 `~/Library/LaunchAgents/com.agentos.knowledge.plist`，标准输出和错误日志放在新实例 runtime。仅停止本实例时使用 `launchctl bootout gui/$(id -u)/com.agentos.knowledge`；修改新实例配置后用同一个 label 重新加载，不能操作 com.agentos.local。Windows 的该独立启动器和本次迁移未实机验证。
