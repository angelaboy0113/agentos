# 审核的运行配置投影

用于排查代码中的服务目标、日志存储或功能开关。Nacos 已连接但旧数据库地址提取器不返回这类配置时，可读取管理员审核的精确键，而不暴露整份配置或凭据。核心不包含业务字段名、系统名或单号。

维护者在原 Nacos 环境的 `queries.investigate.configKeys` 登记键与类型，示例见 `config/config-projection.example.json`。只适用于 reviewed 的 investigate 查询；重启使配置生效，已有批准计划按新指纹重新校验，不能沿用旧票据扩大范围。没有新增依赖。

模型工具为 `read_config_values`，只有配置了 configKeys 才出现在目录中。先 connection/discover，再传实际 ref；可选 keys 只能是登记键子集。跨文件占位符可通过 referenceRefs 指明同命名空间的已发现依赖，不能传 URL、正文或脚本。工具固定 GET Nacos 配置接口，不访问发现的服务地址。

类型：`http_url` 为无认证/查询/片段的 HTTP(S) 地址；`http_endpoint` 仅输出路径地址并移除全部查询参数和片段，发生移除时 queryOmitted=true，不能当成完整可调用 URL。`identifier` 为 ASCII 存储或方式名称，`boolean` 为布尔文本，`integer` 为整数文本，`format` 为简单格式字符串。数值保持文本，不做浮点转换。

结果区分 found、not_found、ambiguous、withheld，并返回 namespace/dataId/group/contentHash。只在显式文件集合解析占位符；不读进程变量、不解密、不猜默认值/覆盖顺序。敏感键/敏感引用、凭据、密文、认证地址被拒绝；已知连接凭据和令牌不得出现在投影中。冲突来源不会静默取第一条。结果按既有工具证据持久化/恢复，不保存配置全文。

配置地址不是上线版本或运行成功证明。发现已有授权 ESB/日志入口后，回原问题继续取证；没有权限时准确指出目标及缺项。不要调用业务接口验证“是否成功”，不要重推、补偿或写生产数据。单个键缺失不应丢弃其它有效证据。

自测覆盖精确键权限、变量解析、秘密/查询参数隐藏、来源冲突、错误参数可修正、不同系统/环境并发、固定 Nacos 来源以及不会跟随配置 URL。真实环境验证与业务根因验收分别记录。macOS 已做真实 Nacos 读取，其它操作系统及完整私有跨机路径未经本次验证。
