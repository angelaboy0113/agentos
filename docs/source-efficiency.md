# 源码准备、调查轮次与空间

新问题先检查指定系统及环境的远端分支 SHA，源码工作区按来源、环境、路径、分支、实际 SHA 的组合复用；同一问题接续仍固定原提交。远端不可读取时保留真实错误，不用旧版本冒充最新。

## 执行链路

飞书入站 → @及身份/系统路由 → 对话分类 → 资源准入/队列 → 远端版本核对与不可变缓存复用 → 主调查Codex会话 ↔ 受控源码/数据库/网页/文件工具及持久回执 → 固定源码最终核验 → 实际文件审阅 → 附件与原卡投递/提醒。

选择 native-tools-v1 的新任务，由主调查会话直接驱动既有环境执行器协程，普通读取不再另建环境规划模型；已存在的 legacy 任务沿用原引擎。已接受的宿主工具仍在执行时，先等待其真实回执，再在原模型会话继续，不能把内部异步单元说成需要用户补充。文档可信生成和审阅仍可能需要接续，不承诺所有问题只有一个turn。工具计数包含源码、文件、网页、数据库与变换，不能当作查库次数；应按实际阶段时间定位重复工作。

## 1.127.0复用

- 整个版本组合相同：复用原不可变快照，仍核对工作树/元数据。
- 一个仓库发生变化：新建版本组合；其他仓库在同环境、同来源、同分支、同SHA且干净时独立复制，支持的文件系统优先COW。避免对未变化仓库再次fetch/checkout/repack。
- 新副本的文件inode、索引和Git元数据独立；不能使用硬链接、alternates或共享worktree。修改新副本不会改旧证据。拒绝忽略文件、脏工作树、路径越界/元数据链接；不安全候选回退原有准备流程。
- 同时到来的问题：持有同项目跨进程锁；仅能合并“本请求开始后完成”的真实远端版本观察，保留其原时间，不延长有效期。稍后新问题仍核对远端，不采用十分钟等TTL猜测版本不变。
- 进度事件 `sourcePreparation`（内部 `sourceSync.preparationMetrics`） 记录 `cacheReused/remoteCheckCoalesced/lockWaitMs/remoteCheckMs/verifyMs/totalMs/reusedRepositories/fetchRepositories`。这些是运行观测，不写入不可变证据身份。

固定祖先历史补取持有共享生命周期锁，并只对目标仓库独占；最终只读核验可与补取并行，回收/替换仍需全局独占，同一仓库的补取保持串行。核验不切换HEAD或下载当前分支，原始清单保持不变。

无需新增配置。仍遵循项目 `analysisSourceRoots`、`analysisSnapshotRoot`、`sourceRepositories`。macOS APFS COW已验证；不支持COW时独立复制，不承诺同等磁盘收益。其他操作系统和完整迁移路径未做实机验收。

## 回收和容量

源码缓存已有按引用回收：保护执行/排队/等待任务、接续、待投递附件与提醒及最新环境版本，删除前再次检查任务引用；不能仅按年龄删除。回收后保留轻量固定提交清单，需要时恢复精确SHA。脏缓存和未登记目录不自动删除。用户已交付文件和数据集按既有保留及引用策略处理，不能结束任务就删掉导致后续文件修改失效。

任务临时规划目录可在其进程结束后回收；可恢复的工作证据/附件不能与临时依赖混为一谈。维护备份另走已登记备份整理，不直接删除整个migration目录。

APFS备份和COW版本的 `du` 合计可能重复计入共享数据块。必须分别报告逻辑目录规模、实际卷剩余空间与真实删除结果，不能把逻辑GiB当成可释放GiB。

## APP证据边界

当前仓库并未提供原生手机/模拟器控制桥。源码、已授权后端读模型和H5/PC请求可以解释绑定与筛选规则；不能把PC登录或数据库现状声称为用户手机当次请求。确实需要移动会话现场时，应明确缺少哪项请求/时间/响应证据，而不是把已能回答的后端规则全部作废或反复查同一源码。

## 验证与回退

回归覆盖不同仓库对象、分支变化/回滚、同时请求、固定提交恢复、脏缓存、嵌套仓、链接和独立元数据。合成局部基准只证明该路径，不能等同整题提速；完整问题的对照须记录同题/变体范围、缓存状态、模型/工具/等待阶段与实际答案。

回退旧代码前自然空闲停稳并备份最新运行数据，不倒灌旧state。新快照仍使用既有不可变策略，`preparation`为额外清单字段；新运行观测应随原证据保留。运行计时通过独立进度字段保存，不混入源码清单；不需要为回退删除业务证据。

Authorized cloud files returned during a native session use that Runner's original artifact workspace capability. Controller job refreshes update durable authorization and task identity, but do not replace this local capability with absent JSON. The host downloads only registered task input IDs with SHA validation and returns localTaskInputs to the same model thread. A registered controller attachment is not proof that a live model has received a readable local file; both stages must be checked when diagnosing file handoffs.
