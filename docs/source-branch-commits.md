# 批量分支提交调查

对于“某分支合入哪些改动”的清单问题，Runner 支持 `sourceHistoryQuery.operation=branch_commits`。输入 repositories、branch、since、until、reason；仓库必须属于本任务原固定源码清单，时间缺省用 null，非空必须明确时区。原系统、环境、身份、HEAD 与已有取证不变。

Runner 在每个仓库已有授权 origin 上仅查询指定分支，第一次观察后固定 SHA。CNB 提交列表接口按该 SHA 逐页读取至空终页，不下载源码、Git pack 或建立共享对象库。最多四个独立仓库的 I/O 同时执行；仓库数、总页数与整任务时长没有新增截止。原有单请求重试策略保持。非 CNB 来源明确 unsupported，仍可使用原分支/历史工具，不偷偷切来源。

完整记录位于任务 `source-metadata/*.json`，通过原源码证据收据和文件摘要交付。模型收到各仓状态、数量、固定 SHA 和 artifact，只在需要时分页读取。`parents.length>1` 表示 Git 合并提交；作者、提交者、平台实际合并者、正式需求归属与部署时间分别取证，不能互相替代。

完整无时间过滤结果必须包含目标 SHA 及所有引用父提交。重复页、缺页、错误响应、权限失败不能判成完整或零记录。部分结果保留有效页及错误分类；同问题恢复保留第一次观察的 SHA，已完整仓库复用，失败仓库可继续恢复。新收据不覆盖旧 artifact。跨进程使用本任务元数据目录锁，原缓存、其它系统和个人工作树不变。

适用流程：一次请求相关仓库 → 批量固定分支并取元数据 → 读取 artifact 整理清单 → 按需要另查合并请求/发布证据 → 核验交付。确实需要旧文件、blame/show/diff 时，原独立参考及固定提交祖先补取能力继续使用。本能力不是所有远端故障都能自动消失的保证。

部署不新增权限或依赖；复用各仓现有 repo-code:r 和凭据 helper。迁移必须携带新增模块、schema、提示词、测试和本文件，私有迁移继续保留 source-metadata、任务身份和收据。回退代码前先等待新操作任务自然结束，保留新增元数据，不倒灌旧运行状态。

验证见 `test/source-branch-commits.test.js`：分页/图完整性、失败恢复、固定 SHA、四路 I/O、双系统环境身份隔离、原始证据不可变、收据和同会话接续。合成回归不代替真人新卡性能验收。

接口依据：[CNB 官方 OpenAPI](https://docs.cnb.cool/zh/develops/openapi.html)，`GET /{repo}/-/git/commits` 的 sha/page/page_size/since/until 参数（2026-11-17核对 Swagger）。

Interrupted response bodies retry the same idempotent page; persisted transient partial results resume at the first incomplete page under the same fixed SHA. Complete pages are not downloaded again. Authentication, malformed pagination and integrity failures remain distinct and are not silently declared complete.
