# 验证记录

2026-10-29，macOS、Node22。本目录使用当前仓库的OS核心，没有替换正在运行的飞书实例。

- 工作台自动回归：14项通过，包括三身份隔离、直链/文件访问、邀请撤销、原OS核心协作、OAuth租户/state、入站与通知恢复、超过5MB文件、路径/符号链接及30天历史保护。
- 原仓库完整回归：666项，664通过；2项原有浏览器夹具测试失败：`isolated browser uses same menu/form/disabled inspection program and keeps network writes blocked`、`real browser waits for login, reuses persistent session, isolates pages and blocks write traffic`。未修改其实现或测试，不能称全量通过。
- 浏览器：新对话/排队与结果、体验文件、邀请二次确认、普通成员侧栏无全部对话、受邀话题可见、390px手机布局已检查。页面所有业务回复明确为合成体验，不读取PRD。
- 尚未验证：企业真实OAuth登录、真实飞书私聊通知、真实模型/PRD取数/报表端到端、Windows部署。需要内网HTTPS地址、回调配置和本实例密钥后完成这些步骤。
- 原服务仍使用原进程、原data和原端口；本目录不自动注册自启动或修改网络/应用权限。
