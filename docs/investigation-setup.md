# 缺少接入时等待补齐并接续原问题

## 使用方式

源码调查发现仍需核对环境、但缺少连接时，不应以“需要管理员补齐”结束任务。开发结果可提交 environmentSetup（kind 为 nacos 或 mysql，tier 为 uat 或 prd，url 为不含凭据的入口或空字符串），outcome 为 needs_clarification。网站继续使用已有 websiteQuery 流程。

已知入口优先复用。确实缺少 Nacos 网址时，在原话题明确询问对应环境的网址；用户回复后继续原任务。需要登录时通知维护者在运行 AgentOS 的电脑上登录，卡片保持等待状态；接入流程检测完成后自动继续，不要求重复描述业务问题或回复“继续”。需要接入确认时，指定管理员可回复“同意”；这不是授权任意用户访问全部环境。

## 实现与权限

源码结果经 server 校验，在 store 的同一事务内生成原问题的接入会话，保留原发起人、使命、图片和已取得的证据。重复租约事件不能重复接续。environmentSetup 只启动补齐流程，不代表已经连接数据库。

Conversations.apply 先复用项目、环境、地址一致的受控连接。只有数据库地址、没有配置来源时，先通过已登记的同环境 Nacos investigate 查询 discover/read_config，取得 namespace、group、dataId 和内容摘要，再进入既有管理员确认与本机凭据接续流程。不得将 PRD 连接用于 UAT，也不要求把密码发到群里。

有多个候选库时询问目标库；没有唯一 Nacos 入口时询问环境入口。接入会话使用 setupPending 保持橙色等待卡片，抑制“任务结束”提示。登录轮询完成后按原发起人的身份重新规划查询，继续遵守 membersRead、环境负责人及本次范围审批；管理员接入确认不会替普通成员获得查询授权。

## 配置与部署

沿用 config/environments.local.json（或 AGENTOS_ENVIRONMENTS_FILE）中的 environments、projectId、tier、membersRead、ownerOpenIdsByProfile、queries.investigate。Nacos 工具查询还需受控 namespaces。复用已有 Keychain/本机凭据存储；无新增密码字段，无需把私有配置加入 Git。更新程序需在无执行中任务时重启；已结束的历史任务不会因升级自动重放。

Mac 使用原有本机登录接入能力；Windows 部署继续依赖对应平台现有凭据与浏览器能力，本次未进行 Windows 实机验收。通用业务网站与 Nacos 专用登录流程仍有区别，不能假定所有登录态自动共享。

## 验证和排错

回归覆盖原问题/身份/附件保留、HTTP 重复事件拒绝、含凭据 URL 拒绝、未知网址补充后恢复、接入完成后恢复原发起人、已知连接复用、裸地址先查询配置来源，以及恢复查询仍需环境审批。使用模拟配置和本机 HTTP 测试，未借发布验证访问真实数据库。

排查时查看 setupTurnId、setupSourceJobId、setupPending、setupTargetUrl 和 environmentEnrollments 状态；不要输出凭据。等待登录、缺网址、等待审批应保留可恢复入口；真实网络不可达、账号无权限、接入失败仍需显示具体原因，不能靠无限重试或绿色卡片掩盖。此变更补齐接续机制，模型仍须正确选择环境、工具并判断证据是否足够。
