# 缺失源码的分支对照

当前固定环境源码找不到明确方法/类时，先检查真实检索范围；不能把未找到当作零调用或业务不存在。源码分析模型可通过现有 sourceHistoryQuery 以下操作继续定位：

- `{operation:"list_branches",repository:"当前sourceSync相对仓路径",branch:null,reason:"缺失目标"}`：读取该原仓同一origin的真实分支名和SHA。
- `{operation:"read_branch",repository:"同一仓",branch:"刚定位的真实分支名",reason:"调查目标"}`：只读下载首次观察SHA，返回独立参考目录和来源清单。

只允许原任务sourceSync已授权仓库，不接受新远端、任意文件路径或新系统仓。只选择有业务/名称证据的相关分支，避免全库穷举。原身份/问题/项目/环境/固定cacheKey与仓库提交进入缓存键；并发锁保护相同任务参考，推进或回滚远端另建或复用对应SHA，不覆盖正在调查的参考或原环境HEAD。首次fetch只深度1；若需要历史，使用`{operation:"reference_history",repository:"原参考仓",branch:"原参考分支",commit:"收据中的完整固定SHA",reason:"历史调查目标"}`补取该固定参考的祖先。只接受已保存收据的同任务/身份/环境绑定，不接受模型路径；跨进程锁内检查独立Git元数据、远端、清洁工作树和固定HEAD，完整后复用，认证或缺失对象保留具体失败，原收据与环境取证不覆盖。同一任务同一版本重用；此工具不取消固定祖先历史工具。缓存位于本任务exports/source-references，跟随任务证据保留和既有按引用清理/迁移，不在业务仓写入。

参考目录不是原环境源码的替代；sourceSync保持原值，输出必须明确参考分支和SHA。静态直接/间接HTTP路由按方法与完整路由去重，测试反射和Feign声明不重复计算。生产采用哪个版本继续走既有TSF/CNB接入核对，镜像标签/分支名不能替代制品内容证明，静态入口数不是实际运行调用次数。未读取到目标分支时保留具体失败分类和原源码证据，不盲重试、不偷偷切换环境。

默认不增加环境/凭据配置或数据权限；继续使用该仓现有只读Git认证。仅此实例macOS实测，其他系统与整套迁移未实测。迁移代码包包含本模块、测试及说明；参考缓存随原任务exports私有迁移，不提交Git。回退保留已生成参考证据和新状态，旧程序不能继续执行新operation请求，先在自然空闲处理未完成请求，不倒灌state。

交接引用可用 `kind:"code",path:"source-references/<返回目录键>/workspace/<仓内文件>"`。程序按本任务收据、原快照绑定、固定Git blob及文件摘要独立核验，不能引用其他任务或任意绝对路径。此命名空间单独标识，不因路径在原源码之外误判失败，也不放宽原工件边界。

## 提交身份与固定分支关系（1.122.0）

用户给出短提交哈希、询问作者/提交者或是否合入时，优先使用：

```json
{"operation":"commit_metadata","repositories":["client-app","order-service"],"commit":"abcdef123","reason":"核对提交身份及本题固定环境包含关系"}
```

仓库必须来自本任务 `sourceSync.repositories`；不接受远端 URL。当前原生适配 CNB，复用该仓既有 Git 源码只读凭据，通过官方固定 GET 提交元数据及 `target...原环境固定SHA` 比较入口读取，不使用浏览器或构建历史令牌，不增加权限、不下载整仓祖先、不切换 HEAD。其它平台明确返回 unsupported-provider，不声称已接通。401、403、404、网络失败及比较失败分别保存；404不是其他仓或整个系统不存在的证明。可批量请求原范围内相关候选仓，未知目标仓时不要仅按业务名称排除客户端。

返回的 author、committer、平台作者及固定分支祖先关系是不同证据。cherry-pick 或单亲提交不能证明谁点击了平台合并；分支包含目标也不等于生产已部署。比较失败保留已取得的提交证据，不降级为整项全无。只有需要旧文件、逐行差异、blame/show/diff及完整祖先时，再使用原历史工具。

元数据保存在本任务 `exports/<jobId>/source-metadata`，工具返回 artifact 和摘要，可作为 `handoff.artifacts` 的 `kind:"code"` 引用；这是提交元数据命名空间，不冒称源码文件。交接核验绑定原问题、机器人、项目、环境、缓存键、原固定仓提交和可信执行收据，校验实际文件摘要、符号链接及硬链接；不允许模型伪造文件后自证。重启、备份和私有迁移须保留 exports 及原执行收据。凭据仅在内存使用，不存文件或日志。无需新增配置或重新登录；如原代码凭据无权读取，明确报告具体权限，不自动扩大。

Current-turn metadata receipts are carried by the Runner through both document materialization and final handoff validation. Multiple query batches retain separate task-bound receipts; saved-stage continuations reuse those receipts. Model-supplied receipt fields are discarded. A successful read does not bypass artifact hash, profile, project, environment or fixed-commit checks.


固定旧快照恢复按父仓优先、独立同级最多3仓并行准备；失败先等待已启动操作结束再清理。已复制的本地固定提交及树能真实检出并核对HEAD时，不重复远端fetch；缺对象才获取同一个SHA。新问题仍核对指定远端分支，历史仍须独立补齐，不能将旧缓存冒充最新。

分支合并/提交清单应优先使用[批量分支元数据](source-branch-commits.md)，在原清单内一次指定相关仓库，避免每查一个仓都先克隆再补完整历史。原独立参考用于确需读取不同分支文件或执行 diff 的情况，不作合并清单的前置步骤。
