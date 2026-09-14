# 从 GitHub 到飞书 Agent 团队：小白完整教程

本教程以 **Windows 单机 + lark-cli 长连接 + ChatGPT 登录的 Codex** 为已验证路径。完成后，你会在一个飞书群里拥有项目负责人、PM、开发、测试和审计五个机器人，它们共用一台受信任开发机上的 AgentOS 与 Codex。

> 这不是云托管机器人。运行 AgentOS 的 Windows 用户需要已登录、电脑不休眠、能访问飞书与 Codex；代码仓库也必须在这台机器上。

## 0. 准备清单

- Git。
- Node.js 22.x；项目 `package.json` 要求 `>=22 <23`。
- Codex CLI 或包含可用 CLI 的 Codex 桌面版。
- lark-cli。
- 能创建企业自建应用的飞书权限。
- 一个测试群和至少一个本地 Git 项目；先不要直接接生产仓。

## 1. 克隆成品仓库

```powershell
Set-Location D:\projects
git clone https://github.com/angelaboy0113/agentos.git
Set-Location .\agentos
git status
```

仓库当前没有第三方 npm 运行依赖；Node、Codex、Git 和 lark-cli 是本机工具。先执行：

```powershell
.\scripts\doctor.ps1
```

诊断脚本只显示版本、路径和缺失项，不打印 App Secret、消息或日志正文。

## 2. 安装并登录 Codex

确认 CLI：

```powershell
codex --version
codex login
codex login status
```

第一次运行 `codex` 也可以选择“Sign in with ChatGPT”。这份 AgentOS 已验证使用 ChatGPT 订阅登录，不需要把 API Key 写进项目。Codex 登录缓存位于当前用户的 Codex 配置目录或系统凭据库，绝对不要提交。

若浏览器回调受限，可根据 OpenAI 官方认证说明使用设备码登录。AgentOS 的 Windows 登录后自启和 Codex 账号登录是两回事：前者决定程序何时启动，后者决定 Codex 能否调用模型。

## 3. 创建五个飞书机器人应用

在飞书开放平台分别创建五个企业自建应用，建议名称：

1. 项目负责人 Agent
2. PM Agent
3. 开发 Agent
4. 测试 Agent
5. 审计 Agent

每个应用都要单独完成：

1. 开启“机器人”能力，设置易区分的名称和头像。
2. 将你和测试群成员加入应用可用范围。
3. 按实际能力申请消息读取、以应用身份发送消息、读取消息资源等权限；不要开启无关通讯录或全量消息权限。
4. “事件与回调 → 事件配置”选择长连接，订阅 `im.message.receive_v1`。
5. “事件与回调 → 回调配置”选择长连接，添加 `card.action.trigger`。它和消息事件不是同一个配置页。
6. 创建版本并发布。负责人应用发布成功不能代替其他四个应用。

## 4. 为每个应用建立 lark-cli profile

下面的 profile 名称与示例配置一致：

```powershell
lark-cli config init --new --name agentos-owner
lark-cli config init --new --name agentos-pm
lark-cli config init --new --name agentos-developer
lark-cli config init --new --name agentos-qa
lark-cli config init --new --name agentos-auditor
```

按浏览器流程选择或配置对应应用。已有应用时先运行 `lark-cli config init --help`，使用当前版本支持的“绑定已有应用”方式；App Secret 使用安全输入，不要写进命令历史、JSON 示例或聊天。

## 5. 生成本地配置副本

```powershell
.\scripts\initialize-local.ps1
```

脚本只在目标文件不存在时复制，不覆盖已有配置：

- `config/agents.local.json`：机器人角色、profile 与机器人 open_id。
- `config/projects.local.json`：真人管理员身份、群与项目、仓库路径和验证命令。
- `config/codex-runtime.local.json`：Codex 路径与直连/代理。

这三个文件均被 Git 忽略。

## 6. 获取群、机器人和真人 ID

首次取 ID 时先确保 AgentOS 没有运行，避免两个消费者争用同一个 profile。以负责人为例：

```powershell
lark-cli --profile agentos-owner event consume im.message.receive_v1 --as bot
```

然后由真人管理员在目标群 `@项目负责人 Agent` 发送“配置身份核对”。从这条事件中记录：

- `chat_id`：目标群 ID，通常以 `oc_` 开头。
- `sender_id`：该 profile 视角下的真人 ID。
- `mentions` 中对应机器人的 `open_id`。

按 Ctrl+C 停止临时监听，对其他四个 profile 重复。**同一个真人在不同应用下的 open_id 可能不同，不能复制同一个值到全部 profile。**

## 7. 编辑机器人配置

打开 `config/agents.local.json`，将每个占位符替换为对应机器人的 open_id；profile 保持和第 4 步一致。新部署可以删除 `legacy` 项。

```json
{
  "agents": {
    "owner_intake": { "displayName": "项目负责人 Agent", "profile": "agentos-owner", "openId": "ou_OWNER_BOT" },
    "pm": { "displayName": "PM Agent", "profile": "agentos-pm", "openId": "ou_PM_BOT" },
    "developer": { "displayName": "开发 Agent", "profile": "agentos-developer", "openId": "ou_DEV_BOT" },
    "qa": { "displayName": "测试 Agent", "profile": "agentos-qa", "openId": "ou_QA_BOT" },
    "owner_audit": { "displayName": "审计 Agent", "profile": "agentos-auditor", "openId": "ou_AUDIT_BOT" }
  }
}
```

`owner_report` 会复用 `owner_intake` 的负责人机器人，不需要第六个应用。

## 8. 编辑项目、群和真人权限

打开 `config/projects.local.json`：

```json
{
  "ownerOpenIds": [],
  "ownerOpenIdsByProfile": {
    "agentos-owner": ["ou_HUMAN_IN_OWNER_APP"]
  },
  "humanIdentities": {
    "leader": {
      "agentos-owner": "ou_HUMAN_IN_OWNER_APP",
      "agentos-pm": "ou_HUMAN_IN_PM_APP",
      "agentos-developer": "ou_HUMAN_IN_DEVELOPER_APP",
      "agentos-qa": "ou_HUMAN_IN_QA_APP",
      "agentos-auditor": "ou_HUMAN_IN_AUDITOR_APP"
    }
  },
  "chatProjectMap": {
    "oc_YOUR_GROUP": "demo"
  },
  "projects": {
    "demo": {
      "displayName": "你的演示项目",
      "repoPath": "D:\\projects\\your-project",
      "baseBranch": "main",
      "verifyCommands": ["npm test"]
    }
  }
}
```

- `repoPath` 必须是这台机器上的真实路径。
- `baseBranch` 必须在项目仓库本地存在。
- `verifyCommands` 由项目负责人审阅后填写；Java、前端和其他工程不能照抄 `npm test`。
- 普通发起人不自动拥有审批权。管理员按对应 profile 的真人 ID 校验。
- `humanIdentities` 最外层键只是本机稳定代号，例如 `leader`、`alice`，不要求等于飞书姓名；同一组内必须是同一个真人在五个机器人应用视角下分别收到的 `open_id`，禁止把一个值复制五次。
- 每位需要跨 Agent 补充、刷新或取消自己任务的成员，都要在五个临时事件监听器中各 `@` 一次对应机器人，再将五个 `sender_id` 写入同一组。只在一个 Agent 下对话的普通成员无需提前登记。
- `humanIdentities` 只延续任务发起人权限，不会让普通成员变成管理员；审批仍只看 `ownerOpenIdsByProfile`。

群聊里的普通问答完成后，机器人会另回一条原生飞书 `@` 给本次提问人。任务最终完成、受阻、失败或取消后，由最初接单的机器人回复原始消息并 `@` 原任务发起人；中间阶段的“待确认/待补充”不会误报为任务结束。该提醒不要求 `humanIdentities`，但跨 Agent 操作仍要求完整映射。

## 9. 配置 Codex 路径和网络

`config/codex-runtime.local.json`：

```json
{
  "proxyUrl": "",
  "codexBin": "codex"
}
```

- `proxyUrl` 留空：Codex 子进程直连，并清除继承的代理变量。
- 确有代理时填写本机实际可用的 URL；不要复制别人的端口。
- Windows 使用 `codex` 时会自动寻找 Codex 桌面版更新后的最新 `codex.exe`。

## 10. 回归并启动

先跑完整检查：

```powershell
.\scripts\use-node22.ps1 npm run check
```

再启动一体化本地服务：

```powershell
.\scripts\use-node22.ps1 npm run start:local
```

看到 Control Plane、Runner 和每个 profile 的消息/卡片消费者 ready 后，在另一个窗口检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

默认只监听 `127.0.0.1:8787`。不要为了飞书长连接把 8787 暴露到公网。

## 11. 拉机器人进群并发送第一条消息

把五个机器人都加入第 8 步配置的群。先验证负责人：

```text
@项目负责人 Agent 你好，请只介绍你自己和当前项目，不创建任务
```

再发一个清晰、低风险的只读请求：

```text
@项目负责人 Agent 帮我查看登录接口在哪里，只分析，不修改代码
```

最后在可丢弃测试仓验证完整流程：

```text
@项目负责人 Agent 在演示项目新增一个 README 小节；先说明目标、范围和验收
```

预期依次经历负责人 → PM → 开发 → 测试 → 审计 → 负责人汇报，并在需要时等待真人补充或确认。AgentOS 不会自动合并、推送或部署业务代码。

## 12. 安装 Windows 登录后自启

先手工启动成功，再执行：

```powershell
.\scripts\install-autostart.ps1
```

它注册当前 Windows 用户的 `HKCU Run` 启动项。关机重启后必须登录这个 Windows 用户，且电脑不能休眠；Codex 与 lark-cli 登录也必须仍有效。日志写入 `data/logs/`。

移除自启：

```powershell
.\scripts\uninstall-autostart.ps1
```

## 13. 验收清单

- `doctor.ps1` 没有缺失项。
- `npm run check` 全绿。
- `/health` 返回 `ok: true`，Runner 为 codex。
- 五个 `im.message.receive_v1` 和五个 `card.action.trigger` 消费者 ready。
- 普通问候只回复、不创建 Job。
- 只读分析能读目标目录但不修改文件。
- 演示任务能停在澄清/审批门；错误身份不能审批。
- 卡片刷新不新建任务；停止任务等待真实进程退出。
- 重启后历史仍在，但没有重复消费同一消息。
- `git status` 不包含 `.env`、`*.local.json` 或 `data/`。

## 14. 更新与排障

更新代码：

```powershell
git pull --ff-only
.\scripts\use-node22.ps1 npm run check
```

在无在途任务时重启 AgentOS。常见检查顺序：

1. `/health` 是否正常。
2. 对应 profile 的消息消费者是否 ready。
3. 是否收到失败卡；收到说明飞书链路已通，继续查 Codex 路径、登录和网络。
4. `codex login status` 是否有效。
5. `proxyUrl` 对应端口是否真的监听；当前网络能直连就保持空字符串。
6. 查看 `data/logs/` 的必要脱敏片段，不把整份日志外发。

所有文件、日志和认证位置见 `docs/storage-and-data.md`；系统边界见 `docs/architecture.md` 与根目录 `SECURITY.md`。
