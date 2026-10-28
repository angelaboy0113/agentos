# MongoDB 受控只读来源

适用程序：1.50.0，更新于2026-10-28。用于已有授权业务库中的文档、跨月集合、去重、统计和完整文件来源。按任务、项目、环境及来源指纹隔离，与同系统同环境的已授权SQL数据集组合，不跨任务借用数据。

## 配置与启动

将 `config/mongodb.example.json` 的环境条目合并到自己部署的 `environments.local.json`，替换固定主机、数据库、认证库、SSH凭据引用、known_hosts绝对路径、真实管理员open_id及审核后的集合范围。示例没有真实凭据，不能直接作为生产配置。密码用本机隐藏终端/Keychain入口保存，仅写credentialRef；不要放进URI、命令参数、聊天、日志或Git。改配置后按实例空闲维护流程重启。

默认 `accountPolicy=strict-readonly` 核验账号实际权限。确需沿用已批准业务账号时，使用现有 `business-readonly` 模式，须由登记的可信管理员明确批准并填写 `businessAccountAuthorization.approverId/confirmedAt`。程序记录账号实际含写权限的事实，只提供固定读协议；不得把工具只读描述成数据库账号自身只读。不会修改账号授权或业务数据。

`kind=mongodb` 必须指定SSH远程执行，绝不在Mac上建立数据库TCP连接，不创建转发、隧道、监听端口或降级路径。SSH使用固定host key、禁用转发。已安装且锁定的应用驱动及依赖打成临时包传到远端 `/tmp`，远端Node执行，结束后删除该临时目录，不执行远端npm install或重启数据库。新驱动不一定兼容旧服务；当前依赖锁定mongodb 5.9.2，已验证Node18与wire version 6的实际连接。兼容性参考[MongoDB官方驱动说明](https://www.mongodb.com/docs/drivers/compatibility/)。其他服务器、操作系统和认证机制应单独验证，不把已验证的一处推广为全部平台。

`readConcern` 可为local或majority，默认local，固定primary读。记录各集合起止时间，不声称跨集合、跨数据库或跨轮读取是同一事务快照。单次网络/数据库请求使用 `executionPolicy.mongodbQueryTimeoutMs`；完整集合工具由逐次请求超时及当前授权检查保护，不增加整个任务或整个多月工具的固定调用/耗时截止。

## 工具与完整性

- `collections` 完整列出当前授权名称范围内的实际集合；仅支持固定集合或末尾星号前缀，不开放其他库和system集合。需要的月份缺失时保留缺口，不按零发生处理。
- `schema` 返回前100条文档的字段/BSON类型普查，只是抽样，不证明每条记录结构相同。`indexes`、`explain_query` 只读元数据/计划，不创建索引或执行写阶段。
- `select` 是有限预览。`group_dataset` 用显式集合列表完整游标读取，支持原始列或count/min/max/sum/count_distinct；旧服务不依赖unionWith，逐集合读取后准确合并。跨集合distinct对实际值和BSON类型去重，不相加各月去重数。sum只接受真实数值，真空值或非数值不能被Mongo忽略后当0；精度超出当前精确十进制支持时明确失败，不丢精度。
- 条件只能是固定结构的字段、比较操作及类型，支持string/date/objectId/int64/decimal/boolean。date必须含时区的ISO时间，非法月份、闰日、无时区及超大整数拒绝猜测。日期条件还核查候选范围字段类型，混合字符串、null或缺失不能被范围筛选静默排除后补零。
- `cohort` 从任务内完整数据集恢复全部主对象键，无1000个样本截断；保存原引用、字段及空值处理，刷新时先刷新主范围、重建键集合。临时in_set只在当前worker有效，不冒充可重放来源。原始记录保存集合名、字段缺失标记；真实null与缺失字段分别记录。
- 已存数据的范围比较由 `transform_dataset` 的gt/gte/lt/lte和显式date/decimal/string类型执行。日期错误不可当范围外；真实null默认报错，排除必须显式声明并有业务依据。

模型没有原始Mongo命令、pipeline、JavaScript、eval、function、out、merge、mapReduce、insert/update/delete、任意数据库或任意远程shell入口。远端worker再次检查集合、字段和只读操作，不依赖提示词阻止写入。

## 保存、恢复、刷新与交付

完整结果进入现有任务数据集存储，保存Mongo查询kind、固定结构参数、集合列表、取数时段和recipe。查询证据身份忽略输出别名和可交换顺序，不能换名字自证金额。来源恢复保留原指纹、摘要、有效期和任务边界；失败不覆盖既有完整数据。

`refresh_report` 先预检完整依赖图，Mongo cohort依赖也在图内，随后按每个来源可信指纹重新匹配同项目同环境且当前获准的入口，不能在当前数据库重放其他库的SQL。按依赖顺序更新主对象引用，再重算派生配方、独立基准和文件。旧临时集合配方没有可重放来源时仍需补齐，不宣称已自动兼容。

文件继续使用compose/finalize/inspect及原投递outbox。连接成功、集合存在、查询结束、程序核验和原业务全部交付各自记录；缺失业务口径或来源时保留等待状态，不把卡片改绿冒充完成。

排查时区分驱动协议不兼容、认证失败、读取权限、集合缺失、日期类型不明、网络和具体请求超时。原始凭据及异常正文不进入群，保留安全错误分类和失败环节。回退代码前保留新配方及数据，旧版不认识新来源时不能直接声称可重放。
