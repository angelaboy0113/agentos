# Security policy

AgentOS runs beside real source repositories and can coordinate Codex changes. Treat its host as a trusted developer machine, not as a public chatbot server.

## Never commit or share

- `.env` and `config/*.local.json`.
- `data/`, especially `agentos.json`, `lark-cli-config/`, downloaded message resources, pending card actions, logs and worktrees.
- Codex authentication (`~/.codex/auth.json` or OS credential-store entries) and lark-cli authentication (`~/.lark-cli/`).
- Feishu App Secret, verification token, access token, real user/bot `open_id`, group `chat_id`, internal repository paths or unredacted logs.

The repository `.gitignore` blocks the standard local paths, but ignoring a file is not a substitute for reviewing `git status` and the staged diff before every push.

## Deployment boundary

- Keep the default control plane on `127.0.0.1`. Do not expose port 8787 directly to the Internet.
- Give each Feishu application only the permissions required for bot messages, message resources and card callbacks.
- Keep the administrator execution and human approval gates. Ordinary group members may chat and request read-only `analysis`; only configured human administrators may create or continue implementation, planning, verification, audit or deployment Jobs. A role prompt is a behavioral rule; process permissions and sandbox flags are the enforceable boundary.
- Treat `humanIdentities` only as a verified cross-bot identity map. It must never grant administrator, code modification or approval rights.
- Use a dedicated developer machine or account for unattended startup. Protect that account with disk encryption and screen locking.
- Runner worktrees may contain proprietary source and uncommitted changes. Back them up and delete them under the owning business repository's Git worktree procedure.

## Before publishing

1. Run `git status --short` and inspect every staged file.
2. Confirm `git check-ignore` matches `.env`, `config/*.local.json` and `data/agentos.json`.
3. Search staged content for App Secret, tokens, `auth.json`, real IDs and personal absolute paths.
4. Run `npm run check`.
5. If a credential was committed, revoke or rotate it first; deleting the latest file does not remove it from Git history.

Report security issues privately to the repository owner. Do not open a public issue containing credentials, message payloads or private source code.

## Analysis source synchronization

Trusted local `analysisRepositories` configuration authorizes Runner to fetch origin and fast-forward named checkouts before read-only analysis. Chat/model output cannot select these targets. This host-side preparation writes Git metadata and updates checkouts; it does not grant write access to the analysis model or implementation rights to ordinary members. See `docs/source-sync.spec.md` for fail-closed behavior and concurrency limits.

## 可选环境查询边界

详见[受控环境查询](docs/environment-access.md)。环境配置仅存在 ignored 的 `config/environments.local.json`，凭据保存在当前 Mac 用户 Keychain。PRD 成员请求及源码排查新增查询先进入 `awaiting_environment_approval`，获指定环境负责人对本次范围批准后才允许 Runner 单次领取。审批不授予代码或数据库写入权限，普通 analysis 沙箱保持只读。查询结果归属原问题卡片，不注入共享长期记忆；真实环境验收须在本机配置后完成。

## Nacos 浏览器只读通道

`investigate.browser=true` 开启独立 Playwright Chromium，固定同源请求白名单和命名空间检查，阻止写入、跨站、重定向和未知接口。模型只取得过滤后的页面与控件引用；凭据只用于本机登录。原配置响应在进入 DOM 前被替换为端点摘要。此适配当前针对 Nacos 2.x，不是任意网站的通用只读保证。首次本机登录捕获成功的表单凭据后存入 Keychain，禁止把登录缓存提交或将密码交给模型。

## 群内环境接入授权

申请接入不触发网络登录；只有本群管理员在对应问题确认后才能打开本机窗口。接入后的查询保留原发起人，PRD成员仍需独立查询批准。入口不允许凭据和查询参数，当前仅支持Nacos固定路径及MySQL库入口。本机界面实际出现才报告打开，配置验证和原始备份后才恢复任务；过期、失败和跨问题批准不能放行。申请描述、URL和工具结果均不授予权限，凭据不交给模型。完成卡片不可被新追问覆盖，明确卡片回复优先于宽泛话题根，避免审批串单。
