# 补充信息提醒

群内原提问进入需要真人补充的等待时，原助手在原话题使用原提问者的 Feishu open_id 发送真实 @ 提醒。先投递问题卡，再提醒；不从最后回复人、凭据提供人或昵称推断提问者。无需新增配置或应用权限。

普通回复的结构化 `replyDisposition=clarification` 沿用原提醒；任务 `awaiting_clarification` 或部分结果明确 `investigation.blocker.kind=user_input` 使用独立 `clarification` 通知。通知指向卡片列出的具体缺项，不复制未经脱敏的模型字段，不要求在群里发送凭据。

模型容量等待、自动登录恢复、源码/数据库/网页阶段接续不要求用户补充；内部 `unavailable`、`approval`、`login` 阻点仍走各自现有机制，不能把所有黄色卡都解释为用户欠信息。无需真人输入的旧卡不追溯催问。

投递复用持久化 cardMessages 出站队列、原身份/话题/代次和撤回/私有交付保护。通知键绑定任务、补充轮次及具体缺项；同一请求重试复用幂等键，重复渲染不重复提醒。补充后再次需要新信息有独立通知，最终完成通知使用原完成键，不被等待提醒吞掉。正式发送前检查最新任务仍是该等待/补充状态，已接续或被新任务替代时跳过旧提醒。私有卡不向公开群发送提醒。

回归入口：`node --test test/clarification-notice.test.js test/requester-mention.test.js test/live-cards.test.js`。实际群内首次补充、重试与完成通知需要分别验收，合成 transport 测试不等于真人完整链路通过。迁移应保留 cardMessages 通知与投递回执；旧版不认识 clarification 类型，不应让旧版接续未送达的新提醒，更不能倒灌旧状态。
