# 持续只读分析协作 — v1.4.2

## 当前执行模型

- AI 判断 `intent=analysis` 后，负责人、PM 或开发入口创建 `continuous_analysis`，只要求配置开发 profile。测试和审计入口仍保留各自的专业单阶段分析。
- 一张问题卡对应一个持久 Job。开发 Codex 在同一个 thread 中检查源码、提出受控数据库或网页查询、读取返回证据并继续自查，直到可以直接回答原问题或出现真实外部阻塞。
- 首步已经明确为数据库、Nacos 或网页查询时也直接创建 `continuous_analysis`；环境结果回到原 Job 后继续同一开发 thread，不经过旧 `single_developer`、`analysis_review` 或 `owner_report` 接力。
- 环境工具是当前 Job 内部步骤：控制面保存查询计划、授权、结果和审计事件，但不再创建后继“开发”Job，也不再额外运行负责人汇总模型。主卡、取消、耗时和结果都归属同一个 Job。
- Runner 池默认 3 个执行槽，允许不同卡片真实并行；同一卡始终只有一个有效租约。等待网页登录、配置或真人输入时释放槽位，恢复后续跑原 Job 和原 Codex thread。
- 同一环境、模板和参数已经被拒绝后再次原样提出，控制面保留诊断并要求调整；连续重复才终止为明确受阻。整项调查没有固定总时长或固定工具调用次数上限。

## 范围与安全边界

- analysis 使用配置的 `repoPath` 或 isolated 源码快照，以 read-only/never 执行；附件保存在 Runner 数据区，不写业务仓，也不运行可能产生副作用的 `verifyCommands`。
- 数据库、Nacos 和网站只通过已配置、已校验的受控只读工具执行。修改代码、数据、配置、部署或业务状态仍走原有实施链和人工权限门。
- Mac 共享 Chrome 复用同一桌面用户的登录态，每个 Job 绑定独立标签页；Apple Events 的单次操作串行化。登录过期时原 Job 进入等待并释放 Runner，手动登录或卡片凭据登录成功后自动恢复。
- 结果记录相关仓库、分支/commit、环境证据和仍未核实项，不能把本地源码等同于实际部署版本。缺代码、权限、入口或登录属于 blocked/等待条件；只有确需用户选择时才请求澄清。
- 原因类结论采用分级证据标准：直接错误响应是强证据但不是唯一条件；数据库异常事实、源码调用链、同批次对照和状态轨迹等多个独立证据一致时可以确认或高度支持原因。只有仍存在会改变结论的合理替代原因时才保留核心结论并继续调查。
- 卡片首屏展示用户能理解的脱敏结论；必要的技术依据、文件位置、环境证据和风险保留在详情中。回答长度由问题复杂度决定，不强制压缩成固定几句话。

## 源码同步与快照

项目应配置 `analysisRepositories`。Runner 在首次源码分析前同步各仓 origin 对应分支；缺少清单或同步失败即阻塞。`analysisSourceMode=isolated` 时，每个调查使用独立快照，保留个人功能分支和未提交修改；环境不明时先询问，禁止回退到其它环境。后续环境步骤返回源码分析时复用首次快照和 thread，不重复 clone/fetch。

## 部分结果与恢复

`outcome=partial` 只用于已经形成可靠结论但仍有明确未核实项的 analysis。最终回答按“已确认、未核实、补齐方法”说明，不把核心验证缺失写成完成。同步失败、无访问权限或没有任何有用证据时返回 blocked。

网页登录等待使用绑定原授权的一次性接续记录。控制面重启后，新 Runner 租约可以恢复同一 Job；过期授权或配置变化需要重新校验。取消后的 Job 不恢复，迟到事件不能覆盖终态。

## 并发、隔离与观测

- `AGENTOS_RUNNER_CONCURRENCY` 接受 1 到 8，默认 3。每个执行槽使用独立 runnerId，`/health` 返回 `runnerConcurrency`，管理控制台显示总槽位、在线和忙碌数量。
- 不同问题的 Job、Codex thread、上下文、页面引用、取消信号和卡片更新互相隔离。项目规范、已登记环境和同一 Chrome profile 的登录 Cookie 可以共享；任务证据和账号密码不进入跨问题长期记忆。
- 单机仍只运行一个 Control Plane 并写一份 `agentos.json`；JSON 事务串行不妨碍 Runner 做耗时工作并发。多机分布式执行不在当前范围。

## 兼容与升级

旧 `analysis_review: developer -> owner_report`、历史收敛任务及其事件继续可读并按旧规则完成，不自动迁移、不重跑。升级后新创建的 analysis 使用 `continuous_analysis`。健康检查的 `analysisWorkflow` 应为 `continuous-developer-tools-v2`。

## 验收

1. 同时创建三张只读问题卡，观察三个 Runner 槽并行忙碌；第四张在槽位释放前排队。
2. 让一张卡依次经过源码、受控环境查询和源码复核，确认始终只有一个 Job ID，最终没有 `nextJobId`。
3. 让网站任务进入登录等待，确认 Runner 槽释放；登录后确认原 Job、原卡和原 Codex thread 自动恢复。
4. 取消其中一张卡，确认仅该 Job 结束，其他并发任务继续。
5. 运行 `npm run check`，并核对 `/health`、管理控制台和飞书卡片中的流程、耗时与结果。

自动化证据见 [持续并发执行验证](continuous-execution-verification.md)。
