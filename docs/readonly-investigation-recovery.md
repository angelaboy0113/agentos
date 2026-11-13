# 只读调查接续：副本集、页面状态与证据摘要

MongoDB 连接检查成功不代表业务查询能够读取。固定直连的目标若为副本节点，主节点读取会被拒绝。经维护者核实副本集身份后，可在既有 MongoDB 环境增加 `replicaSet`（见配置示例）；SSH 远端官方驱动通过该副本集选择当前主节点，不静默降为副本读取。默认未配置仍为旧直连模式，系统/环境/数据库/认证库/集合与固定记录限制保持。连接证据返回拓扑模式、主/副角色与 primary 读取策略；不可用时明确报主节点选择失败，不当作空数据或密码错误。新增字段进入配置摘要，旧任务须按维护流程复核原范围后接续。

只读导航支持既有 `readNavigationSelectors`：维护者审阅真实组件后登记固定 class/id。模型只能点当前页面引用；仍核对标签、可见性和用途，服务器写请求仍拒绝。不要为了进入管理后台而开放整个页面、任意选择器或保存/删除等操作。

页面字段读取同时给出 checkbox/radio/switch 的 `checked` 状态，true/false/mixed/null 分开；读取不点击开关。没有状态属性时为未知，不能将控件存在推断为启用。

工具证据索引 `sha256` 是 UTF-8 `text` 的摘要；新增 `envelopeSha256` 是整个外层 JSON 文件摘要。两种摘要不能交叉比较。旧信封仍兼容，原内容完整性校验不变，摘要有效不能代替业务结论核验。

验收应覆盖副本目标/主节点选择、跨系统与集合范围、缺参修正、只读导航及写控件拒绝、勾选状态、旧证据恢复。真实历史日志不存在仍须如实说明，不因程序修复将未核实业务问题标绿。配置、凭据与运行证据只随原私有迁移流程转移；本次 macOS 实测不代表其它操作系统或完整跨机迁移已通过。

撤回与正在返回的旧投递失败存在竞态：以API已确认的撤回身份、范围和精确原payload摘要判定退役，不以可被旧失败覆盖的展示文案判定。迟到失败不复活投递，不伪造成功回执；新payload/目的地或活动worker仍保护。

### Quantity changes and premature clarification
For before/after counts, follow the actual metric implementation and schema through population, status, relationship existence/effective bindings and snapshot semantics. A narrow field projection or one denied page is not proof that the authorized evidence is unavailable. Reuse saved complete datasets and fetch only the actual missing dependencies. Do not brute-force arbitrary filters to reproduce a number. Request user clarification only for a genuine unresolved choice or missing indispensable input. Independent key-set differences, actual change audit and matching implementation can support a qualified causal answer without replaying historical clicks. This is investigation guidance, not a new permission grant or a guarantee that historical evidence exists.

User terms such as tag/category/status need not name a storage dictionary. Match the real UI label to its actual filter/boolean/enum before declaring the concept unavailable. A verified stable mapping is a lead; it neither grants cross-task data access nor makes historical counts current.

### Reviewed guidance compatibility
`config/harness.json` may contain `reviewedGuidanceTransitions`: an array of `{fromFingerprint, toContentHash, scope: "guidance-only", review}`. Only a maintainer who has reviewed the actual historical and new role/standard diff may add an entry; a model must not produce or authorize one. Both hashes are SHA-256. `fromFingerprint` is the historical harness metadata fingerprint. `toContentHash` hashes `JSON.stringify({manifest, texts})`, with the transition registry omitted from `manifest` and all roles loaded in loader order. Thus adding an attestation cannot authorize later role or standard changes. Each target change requires renewed review.

On resume the loader keeps the original context and old evidence untouched, records accepted prior fingerprints in current metadata, and still rejects unknown changes, invalid entries or changed target text. This does not migrate approvals, grant credentials, add data sources or weaken environment/identity checks; these are separately revalidated. Removing a review record restores strict rejection for that old fingerprint. Include the registry and roles together in code/migration packages. Actual macOS old-task replay and package verification are separate from synthetic compatibility tests.

A user saying “the system tag/category” does not itself identify a physical dictionary column. When exactly one live UI control matches the concept and its request/source mapping is verified, state that interpretation in the answer and file rather than blocking a reversible read. Explicit technical field choices, a rejected interpretation or multiple real business definitions still require clarification. This guidance does not authorize guesses based on similar names or matching counts.

Invalid knowledge answers are withheld from intake candidates and recheck instructions. Conflicted, corrected, stale-source or otherwise invalid answers remain auditable in the knowledge store but are not reinjected as investigation rules. A topic and invalidation reason can guide fresh discovery. Only currently verified knowledge selected for a live-data recheck retains its method text; this does not reuse old amounts, grant scope or skip fresh evidence.


### Knowledge conflicts after restart

A fact contradiction remains a discovery-only topic while the relevant dependency hashes and deployment marker are unchanged, even if an older runtime marked it active during reconciliation. Startup semantic comparison may repair uncertain paraphrases but cannot supply new factual evidence. A freshly verified changed dependency or deployment may supersede the old rule through the normal evidence capture path. Inspect `unresolved_contradiction` separately from authorization or database errors; no end-user credentials are required to rediscover the mapping within existing scope.

Transport-suppressed withdrawn cards without positive withdrawal proof remain candidates for the normal read-only watcher. Only exact same-profile/chat/message API deleted=true retires their payload; errors remain retryable and no successful delivery receipt is invented.
