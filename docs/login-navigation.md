# 网站登录身份导航

扫码/SSO网站可配置 `{"loginNavigation":{"interactive":true,"steps":["微信登录"]}}`。该路径只打开维护者审核的精确登录入口，并识别自定义文本控件与非标准扫码弹层；不读取密码、不代扫二维码、不确认新增授权。已显示验证界面时复用它，不重复打开。公共首页上的登录入口本身不等于登录失效；私有页面明确提示无权限并存在登录入口时，应尝试原身份认证，而非直接把404解释成仓库不存在。跨源二维码和状态轮询须按 `website-static-resources.md` 单独审核 `loginReads`。

隔离浏览器的登录会话按项目/环境/来源持久化在受限的 website-sessions 中，不能从个人Safari或另一项目悄悄复制登录态。网站自身使Cookie失效后，密码型站点沿用已保存凭据；只提供微信扫码的站点仍可能要求本人再次扫码，永久API令牌不能替代网页登录。`verificationImageReady`、`verificationFramePresent`、`verificationExpired` 仅报告可见认证界面的状态，不返回二维码数据或临时认证标识。SharedChrome路径未接入新的interactive自动打开方法，需由本人在已授权页面完成登录，不能把隔离路径验收扩展为全部浏览器均通过。

1.72.0。用于同一网页同时有外部客户、内部员工等登录入口的情况，避免把已保存管理账号填到默认外部身份。此项仅由维护者根据真实页面配置，不接受模型临时指令。

在已批准website环境增加：

```json
{"loginNavigation":{"usernameLabel":"Internal account","steps":["Internal staff","Password sign in"]}}
```

steps是页面上实际存在的精确button名称；usernameLabel是目标账号input的可见关联label、aria-label或placeholder。必须逐一审阅，不能配置保存、删除、重置、授权等业务动作。不要把账号密码放入这些字段。入口不存在/不唯一/换域/目标字段未出现时失败保留，不猜角色，不先提交密码。已出现目标字段时不重复切换，已有登录成功会话不重新登录。自动提交仍由原网站凭据服务从Keychain读取。

若站点提供明确的同页面登录模式URL，可选entryUrl（HTTPS同源同pathname、无凭据的实际页面参数）。导航固定程序只在登录入口选择时以History API设置该地址，让应用自身按模式处理；不读取/写入任意页面状态、执行管理员配置脚本或跳至其它域/页面。禁止用它绕过MFA、验证码、密码升级或业务授权。模式参数来自已审阅页面/源码，不能编造。

仅macOS日常Chrome接管和隔离Playwright实现了该配置；需要按部署实际路径验证。新配置改变环境指纹，旧未完票据须按现有范围重新核验。发布/配置重载必须自然空闲及备份，不停用户任务；回退时先移除新字段并检查任务兼容。账户本身可能有写权限，但调查工具继续只读，不声称账户权限已降为只读。迁移包含新模块/说明及私有环境配置；凭据通过Keychain安全重配，不进入Git。

扫码站点的登录会话由隔离浏览器持久目录保存，按项目、环境、来源隔离。已登录时复用，不每天主动退出再扫码；永久源码/构建API凭据不是网页登录Cookie。出现登录入口时先检查资源和认证请求诊断，只有页面完整且真实登录失效才提示维护者扫码。扫码后等待原任务自动恢复，不重新建题；不能复制个人浏览器Cookie或静默扩大其他系统会话。

浏览器把后台Worker脚本归为`other`时，仍仅允许已审核公共目录中的`.js`，通过独立无认证GET读取；不允许任意other响应、JSON数据、页面导航、写方法或越界域。

## 多跳 SSO 身份页（1.128.0）

身份提供方跳转需由维护者核对实际请求，配置 `loginNavigation.pages` 为精确 HTTPS 登录/授权路径（无查询值、凭据和通配符）。此配置仅允许观察认证页，不允许代点同意授权、填写其它来源凭据或读取其它系统业务数据。`queries.<id>.loginReads` 保持明确来源/路径/资源类型；默认 GET，确属扫码初始化、状态轮询的 POST 必须显式 `method: "POST", reviewed: true`，只在原任务等待登录期间生效，不匹配子路径，不放行业务写入。嵌套 redirect_uri 只经过已审核身份页回到原应用；身份提供方显示成功并不代表应用已登录。

登录页 JS/CSS 仍通过审核公共静态目录无认证读取；仅已登记身份页可按 XHR 获取该目录内 JS SDK，不能借此读取跨域业务 API。跨多次跳转的 DOM 读取在单次读取窗口内重新核对原任务授权并重试，不重放点击、凭据提交或业务查询。纯扫码提示能识别为验证等待；密码表单中的扫码切换按钮不会阻断原有密码登录。项目、环境与来源持久会话继续隔离。

修改配置改变访问指纹，旧等待任务必须按原身份/环境/问题范围重验。发布前备份，自然空闲重启；回退旧版前移除 pages 和新增认证 POST 配置，保留最新任务、工件、凭据及投递回执，不倒灌旧状态。共享 Chrome、其它操作系统与完整跨机迁移须另行实测，不能从隔离浏览器推断通过。


### 同地址入口统一与旧登录等待

同一项目、运行环境和业务 URL 的历史入口可能重复存在。维护者应选择已审核的完整入口设为 `applicationRoot: true`，同时核对其业务只读接口、SSO 身份页、认证初始化/轮询、静态资源目录及管理员绑定；不是仅补一个登录按钮。目录只展示该根入口，新请求即便显式选中同 URL 的旧 ID，也按此根入口重新签发授权。同地址的历史配置保留，不合并它们的权限或凭据，不更换已经签发的旧授权；跨项目、测试/生产、协议及应用路径均保持隔离。根入口歧义会报错，不猜选。

更改配置后，已等待任务的旧指纹仍需维护者核对并按原身份、原目标、原参数重新签发。普通过期且配置未变会自动续期；配置已变会明确显示“旧任务访问凭证需复核”，保留已有证据，不误报密码错误或要求反复扫码。取消/撤回任务不恢复。发布前备份并记录精确新旧指纹、原任务和固定源码，回退时保留新状态/SSO回执。

验收分别检查：同 URL 旧 ID 和新话题选择同一根入口；其它系统/环境不借用；旧签名不静默升级；真实登录页和二维码加载；扫码后必须在原应用确认登录，再核验日志检索。二维码可见不等于已经取得日志或业务结论。


### 已有身份授权的明确恢复

loginNavigation.renewal 是默认关闭的维护配置，包含 page（已登记HTTPS身份页）、application、account、markers（至少两条“此前已授权/重新授权”提示）和 button。只在原页面、应用、账号及全部提示匹配且按钮唯一时，尝试一次恢复点击；原应用登录成功才重置。首次授权、账号改变或页面不符均不点击，模型不能设置这些值。

认证确认接口必须显式审核固定 POST，并以 loginReads.bodyParameters 精确绑定原应用ID、原身份ID和原权限范围。每项为允许的字符串数组，请求体键集合必须完全相同；缺字段、新字段、权限增加、其他身份、重复JSON键均拒绝。例如 bodyParameters: {app_id: ["your-app-id"], user_id: ["your-existing-identity-id"], scope: ["your-already-granted-scope"]}。真实身份与应用ID仅在私有配置，不向模型暴露。不是业务写授权，不自动增加OAuth权限。

须先核对实际原授权页面和请求字段。若需要新权限，应按权限申请流程处理；二维码出现不能代替授权确认及原应用回跳验收。


Reviewed GET endpoints can declare `queryParameterTypes: {start: "isoTimestamp", end: "isoTimestamp"}`. Only canonical UTC ISO timestamps (optional milliseconds) pass; invalid dates, missing timezone, mutation values and unreviewed methods remain rejected. This distinguishes read-range start from a start operation. Bind types only after verifying actual request and deployed client evidence.

1.132.9: Reviewed read-page time filters now use the same typed query validation during navigation and plan verification. Compound query/search-analysis buttons and dialog-local date/time range apply controls are available; mutation labels and off-dialog lookalikes remain blocked. Native custom range navigation/query integration regression included.
