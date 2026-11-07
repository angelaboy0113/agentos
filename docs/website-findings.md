# 网页调查入口判断与接续（1.76.1）

适用：已接入的业务页面、共享网关/ESB/调度管理平台。能登录但未找到某接口/记录，与实际打开另一应用，是两种不同情况。

`report_wrong_site` 现在提供 `kind`、`targetKind`、`expectedApplication`、`observedApplication`、`evidence`、`reason`。程序在原任务/租约/权限内重新取得 `browser_snapshot`，验证实际网址、页面文本中观察到的应用及原文证据。缺字段、伪造片段、加载/登录页、把接口未找到当其他应用，都返回可修正的 `WEBSITE_FINDING_INPUT`，不终止整任务。无需新增账号或权限。

- `other_application`：目标类型须为 application，明确不同应用且当前页面未包含预期应用；仅该页面有不匹配证据。
- `target_not_found`：平台已打开但接口/记录尚未定位。向同一问题交回具体缺口，可按既有入口的应用目录、筛选与保存证据继续。
- `navigation_blocked`：保留具体读取步骤与证据，交维护核实受控端点，不将其当密码错误。

程序保留 `websiteFinding` 的页面位置（去除查询参数）、时间、实际片段及原因到环境结果、源码接续和交接上下文，旧 `websiteMismatch` 兼容读取。旧布尔主张没有具体页面证据时，先复核原登记入口，不永久排除整个平台，不反复要求用户提供已有地址或密码。当前快照可见内容并不证明平台上所有应用都已查遍；模型仍须选择与原问题有关的应用/日志并核实过滤实际生效。

登录仍由原凭据引用与浏览器会话恢复；读取不到Keychain、明确认证失败、人工验证码分别处理。入口判断工具没有创建新登录或取消请求门控，也不能运行任意JS、选择器或网络请求。角色Markdown未改，不变更已批准任务的规范指纹。

RestCloud某版本展开日志使用固定 `GET /restcloud/rest/core/monitor/log/details?id=<真实列表记录ID>`，参考 `config/restcloud-read.example.json`。必须审核部署平台实际前端及真实HTTP响应后追加，不能把API执行、测试、重放、保存或发布路径纳入。显式登记的端点固定其审核方法，不能因为路径名像details而自动允许POST回退；HEAD/OPTIONS保持原处理。详情不一定保留报文，HTTP200不等于业务根因查清。凭据与请求/响应头不进入报告；仅保留本问题所需的业务匹配字段。

验证：`node --test test/website-finding.test.js test/website-target.test.js`；然后运行 `npm run check` 和 `node scripts/verify-capability-package.mjs`。测试覆盖共享平台、真错应用、缺失/伪造证据、登录/加载、导航拦截、隔离任务受控快照、旧结果与交接。实际业务记录、原卡投递及部署另行验收，不能与合成测试混同。macOS本机实施；其它平台/OS与完整跨机迁移未因此自动通过。

迁移包含本模块、测试、本文与示例；私有环境/Keychain/任务证据仍走原私有迁移。兼容回退保留已有websiteFinding审计，不能回灌旧业务状态；只有自然空闲才按实例流程发布或回退。
