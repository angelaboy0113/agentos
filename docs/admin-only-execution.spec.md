# 管理员实施权限门禁

## 目标

群内普通成员可以正常对话、获取解释并发起显式只读源码排查；只有真人管理员可以让 AgentOS 创建或继续任何可能执行修改、规划、验证、审计或部署的任务。

## 权限真源

- 当前机器人 profile 优先读取 `projects.local.json.ownerOpenIdsByProfile[profile]`。
- 未配置 profile 级列表时兼容 `ownerOpenIds`。
- `humanIdentities` 只把多个机器人视角下的 ID 识别为同一个真人，不授予管理员权限。
- 不按飞书姓名、群管理员头衔、模型推断或回调自报字段授予权限。

## 强制边界

- `reply` 普通对话不创建 Job，所有群成员可用。
- 普通成员仅能创建 `taskIntent=analysis` 的只读 Job。
- `implementation`、`planning`、`verification`、`audit` 及未知/历史非只读 Job 的创建或继续，必须通过真人管理员校验。
- 校验发生在 AI 决策之后、Job 持久化之前；提示词仅改善交互，不能替代程序门禁。
- 卡片和自然语言补充共用同一继续任务门禁，避免从不同入口绕过。
- 原发起人仍可以刷新、翻页或取消自己的任务；取消只终止工作，不扩大修改权限。
- 阶段审批和项目绑定继续只允许真人管理员。

## 兼容性

- 已有 `analysis` Job 允许其原发起人继续补充。
- 缺少 `taskIntent` 的历史 Job 对普通成员按非只读处理，仅管理员可以继续。
- 持有本机管理令牌的开发注入接口属于受信运维边界，不对飞书群成员开放。

## 可选环境查询边界

详见[受控环境查询](environment-access.md)和[只读排查自动授权](read-only-auto-authorization.md)。环境配置仅存在 ignored 的 `config/environments.local.json`，凭据保存在当前 Mac 用户 Keychain。查看源码、配置、日志、数据库和网页的受控只读操作自动执行；修改代码、数据、配置、部署或业务状态仍由管理员门控。查询结果归属原问题卡片，不注入共享长期记忆。
