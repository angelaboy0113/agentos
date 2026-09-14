# AgentOS Codex 直连与新版 CLI 兼容验证 · 2026-09-11

## 现象与根因

- 飞书项目负责人已收到消息并返回失败卡片，控制面与飞书订阅正常。
- 对应对话 `CHAT-20260911110329-03f4b4` 用时 91.087 秒、重试 8 次，最终为 `Codex 对话超过时限`。
- 当时本地运行配置强制使用 `http://127.0.0.1:12000`，但该端口没有监听，因此 Codex 请求无法出站。
- Codex 桌面应用已升级到 CLI 0.153.4，旧的版本哈希路径失效；新版还会拒绝仅含 `mcp_servers.node_repl.enabled=false`、却没有 command/url 传输定义的临时配置，app-server 会在联网前退出并报告 `invalid transport`。

## 已采用修复

- 本机 `config/codex-runtime.local.json` 将 `proxyUrl` 显式留空，AgentOS 子进程清除继承的 HTTP(S)/ALL_PROXY 后直连；未修改系统代理或 Codex 全局设置。
- 当本地固定路径失效或配置为 `codex` 时，Windows 自动扫描当前用户桌面版 Codex 的版本目录并选择最新有效的 `codex.exe`；显式 `CODEX_BIN` 仍优先。
- 移除与 Codex CLI 0.153.4 不兼容的临时 MCP 覆盖。聊天仍禁用插件、应用、shell、浏览器、计算机控制、图片生成和网络搜索，并拒绝 app-server 发起的工具请求。

## 验证证据

- 本机真实网络、现有 ChatGPT 登录、无代理：app-server 初始化 157ms，账号类型 `chatgpt`；两轮合成对话分别 3.692 秒和 2.542 秒，均 0 次重试。合成输入不发飞书、不读取业务代码。
- `scripts/use-node22.ps1 npm run check`：73/73 通过。覆盖空代理清理、桌面 Codex 自动发现、`CODEX_BIN=codex` 哨兵值和旧 MCP 参数移除。
- 无在途任务及对话后重启；`/health` 返回 `ok=true`，Runner 为 codex 执行器，6 路 `im.message.receive_v1` 均连接，启动日志无 Codex 预热错误。
- 旧 default 兼容应用的卡片回调仍未订阅；项目负责人等职责应用回调配置不由本次网络修复改变。

## 边界

- “浏览器可访问外网”不能单独证明 Codex 接口可用，应以不发飞书的真实 Codex 烟测为准。
- 网络环境再次变化时，可在本地运行配置或 `AGENTOS_CODEX_PROXY_URL` 中恢复代理；修改后需重启 AgentOS。
- 本次没有发送真实群聊验收消息，最终用户体验由下一条群消息确认。

## 飞书方案同步

- 原飞书落地方案已升级为 v2.1.0，局部更新并回读至 revision 148；同步范围为引言、4.3、6.2、11.1、13、14.3、15.1，写入均无警告。
