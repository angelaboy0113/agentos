# macOS 日常 Chrome 登录态复用

## 配置与使用
Mac 默认 shared-chrome 后端，使用 Apple Events 接管日常 Google Chrome 的对应应用页面。不复制 Cookie、不读取密码、不打开远程调试端口、不关闭或重启 Chrome。登录过期仍需本机配合。其他平台默认 isolated；设置 AGENTOS_BROWSER_MODE=isolated 并空闲重启可恢复独立 Playwright 浏览器。

激活日常 Chrome，从 Mac 屏幕顶部选择“查看 → 开发者 → 允许 Apple 事件中的 JavaScript”。全屏时把鼠标移到顶部。系统首次询问运行 AgentOS 的宿主可否控制 Chrome 时，由本机使用者确认。该开关允许获准本地自动化程序执行网页 JavaScript，应只对信任的程序开启。未就绪返回 BROWSER_BRIDGE，不应解释成网站账号无权限。

## 执行与权限
环境计划批准后才接管。每个命令重查任务授权，按完整入口匹配 origin 和应用路径；不读取无关标签页正文。每任务固定一个标签，多个任务不共享活跃标签，操作串行。找不到匹配页时在日常 Chrome 当前窗口新建已批准入口；多 profile 用户宜先在目标 profile 打开业务页面。任务结束不关闭用户页、不退出浏览器。人为切到范围外页面时拒绝读取。

提供脱敏可见正文及筛选后的查看、搜索、分页控件；不读取 Cookie、localStorage、密码输入值及隐藏 noscript 提示。工具使用固定脚本，不接受模型脚本。引用按任务和快照隔离，控件标签或链接变化时失效。写入按钮及跨应用链接不开放。原成员权限与 PRD 审批仍保留，登录态不等于群成员授权。

## 与独立浏览器的区别
日常 Chrome 正常加载网页请求，不再全局拦截登录、菜单或权限初始化。此模式不是网络层只读沙箱：控件筛选不能证明网站自身事件处理器无副作用，也不能隔离同一 profile 的后台网站行为。要求严格网络拦截的部署应选择 isolated；本次没有扩大 AgentOS 保存、删除、提交或执行任务的权限。

此后端仅支持 macOS Google Chrome。Nacos 专用配置读取浏览器不走通用网站后端，本变更不迁移其登录态。仅读取顶层应用，跨域 iframe 或复杂自绘控件仍可能不可读。

## 排障与验证
BROWSER_BRIDGE 检查 Chrome 是否运行、Apple Events JavaScript 开关和系统自动化权限；BROWSER_SCOPE 检查是否关闭或离开原应用。网站可见 no-access 保留为事实，但不能仅凭它认定账号权限根因。

测试使用模拟传输和本地页面，覆盖授权重查、独立标签关联、过期及跨任务引用拒绝、写入及跨域控件过滤、可见文本、密码不读和错误分类。模拟测试不代表真实接通；每台机器仍需启用系统权限后只读验收。没有向业务群发送测试消息或点击业务操作。

官方说明：https://www.chromium.org/developers/applescript/
