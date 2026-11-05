# 原生表情包登记与成功回复

版本 1.61.0，更新于 2026-11-05。这是确定性的消息交付功能，不经过模型或工具规划，不修改业务成功判断。

## 配置、权限与使用

在自己的 `config/agents.local.json` 中，为每个已核实机器人条目设置 `successStickers: true`，并保留其唯一 `profile`、真实 `appId`、`projectId`、群白名单与 role。默认关闭；布尔值之外或缺 profile/appId 的启用配置会在启动前拒绝。`config/agents.example.json` 提供禁用示例。可信 `projects.local.json` 的 `ownerOpenIdsByProfile[profile]` 决定管理员身份（应用内 open_id）；不得靠昵称或另一应用的 ID 判定。未设置分应用管理员时沿现有全局管理员兼容规则。

需要机器人能力、已订阅 `im.message.receive_v1`，以及 `im:message.p2p_msg:readonly`、`im:message:readonly`、`im:message:send_as_bot` 和 `im:chat:read`；群消息读取沿现有应用授权。已有权限可直接复用，无需新建事件消费者。修改配置后按实例维护流程自然空闲、备份、重启原唯一服务；不得中断其它活动任务。

管理员分别私聊目标机器人，从飞书**表情包面板**发送原生表情包，不是图片附件、截图或文本 emoji。收到的事件必须是 `message_type=sticker`、`chat_type=p2p`；群聊和非管理员被忽略，不交模型。程序使用同一机器人读取该 message_id 的原始内容，核对消息 ID、chat_id、发送者 open_id/类型、消息类型及未撤回状态；再以群信息的 `chat_mode=p2p` 核对单聊。CLI 的占位文字不作为 file_key，也不下载表情资源。有效 file_key 按 `profile:appId` 独立存储、去重。成功回复：`原生表情包已登记，素材库现有 N 张`。重复消息不重复回执；重新发同张素材仍可确认 N 不变。

飞书原生 sticker 仅能发送该机器人实际接收过的 file_key，不能跨机器人复制素材库。参考：[官方内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)、[读取消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)、[原生回复](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。

## 成功与交付顺序

素材库首次登记后，仅其后**新创建**的公开群问题生效，不回补旧卡或将旧问题补充重开误当新问题。原问题的机器人、项目、群和身份保持。每个问题的用户轮次（question.generation）只选一张；内部阶段刷新或 cardGeneration 变化不重复发送：业务结果必须成功（任务 completed/ready 或正常的直接问答），无活动任务/待审批/补充条件，主卡确为已送达的绿色终态，完成通知有送达记录，本轮所需报表组件以及已登记截图附件都已送达。不能用绿色颜色单独放行，也不能因 outbox 尚未建立就假定附件已送达。失败、受阻、部分完成、等待、私有/查人任务全部跳过。

通过原生 `POST /open-apis/im/v1/messages/{message_id}/reply` 发送 `msg_type: sticker` 和 JSON 编码的 `{file_key}`，沿用原 profile、原问题 message_id 及 `reply_in_thread`。不是表情 reaction 或图片上传。选中的 key、目标、轮次、UUID 在发送前保存，网络失败/重启/增加素材后都不重新随机、不重查业务。任务或身份/环境范围已变化时不发旧轮表情。

飞书回复 UUID 的平台去重窗口为一小时，不能宣称无限期 exactly-once。对于请求已经发出但回执未确认的异常，55 分钟起暂停该条可选消息的自动重发并记录 `reconciliationRequired`，由维护者按原消息、应用和记录核对是否已发；不要换 UUID 盲发。已确认回执永久去重；正常短暂失败继续沿同 key/UUID 退避重试。此约束仅防止装饰性消息重复，不截停模型任务、业务查询、文件投递或完成通知。

## 持久化、恢复与排错

登记事件在本机数据目录 `lark-cli-events/<profile>/pending-stickers/` 先保存再交控制面，失败和启动会重放。同一 state writer 在 `agentos.json` 保存 `stickerLibraries`、`stickerRegistrations`、`stickerDeliveries`。素材及来源记录不进入模型、知识库、Git 或公开日志。登记回执失败不丢素材，成功回复失败不改变业务卡状态；原素材和回执随私有迁移包的整个 data 目录保留。现有历史保留会保护尚未交付表情所依赖的问题；清理已结束问题时移除相应成功回复记录，素材库保留。

排查依次看：profile/appId 与管理员映射、sticker 事件接收、原始 GET 的消息/会话校验、登记确认回执、library.activatedAt 与问题创建时间、业务成功和卡片/完成提醒状态、附件回执、stickerDeliveries 的 retryAt/error/reconciliationRequired。失败摘要不保存原始 CLI 凭据或敏感异常。停用功能将 successStickers 设 false 并安全重启，保留库和回执；重新启用不改变原首次登记日期。恢复不同 appId 不自动复用旧库。

## 验证范围

回归涵盖三机器人隔离、管理员/非管理员/群消息、原始内容核对、去重、断网登记事件恢复、确认消息重试、卡片→完成通知→附件→原生表情顺序、持久化固定随机选择/幂等键、并发 tick、旧轮和私有任务拒绝、超平台去重窗口及保留/清理。测试用合成 file_key，不向业务群发送测试消息。

真实应用权限检查、服务启用不等于真实素材登记与成功任务端到端验收。只有管理员发来第一张原生 sticker 并收到 N 张确认后，才能记录该机器人的真实登记验收；成功任务原话题 sticker 回执另行核对。macOS 当前部署单独记录；Windows、完整私有跨机恢复不未经实测宣称通过。
