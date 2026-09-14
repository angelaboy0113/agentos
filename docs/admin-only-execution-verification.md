# 管理员实施权限门禁验证

## 自动化覆盖

在 Windows 上以 Node 22 执行完整回归：`node --test`，80/80 通过。

- 普通成员创建 `analysis` 成功。
- 普通成员创建 `implementation`、`planning`、`verification`、`audit` 均在 Job 落库前被拒绝。
- 普通成员不能通过自然语言补充继续非只读 Job。
- 普通成员不能通过卡片补充继续非只读 Job；管理员可以。
- 跨机器人 `humanIdentities` 映射后的普通成员仍不获得实施权限。
- 对应 profile 的真人管理员可以创建和继续可执行任务。

## 部署验收

1. 在没有在途任务时重启 AgentOS。
2. 请求 `/health`，确认 `executionPolicy=admin-write-members-analysis-v1`。
3. 由普通成员分别发送只读排查和修改代码请求：前者应创建 `analysis`，后者应被拒绝且不产生 Job。
4. 由真人管理员发送实施请求，应正常进入既有交付链。
5. 验证结果只记录状态与任务编号，不把真人 ID 或消息正文提交到公开仓库。
