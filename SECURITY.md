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
