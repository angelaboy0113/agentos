# 报表粒度与参数修复接续

适用：同一主对象包含多个月份/分类明细，或主对象没有明细但仍需保留的查询、表格和导出。不包含特定项目字段与业务筛选规则，实际表/字段/金额单位须经源码和schema核实。

## 工具选择

- `enrich_dataset`：主对象唯一键、右侧唯一维度查找，不能展开一对多，重复键仍拒绝猜选。
- `linked_group_dataset`：两张已核实基础表等值关联，按实际对象/月份/分类分组。`join.type`默认`inner`，显式`left`保留左表全部合格对象。
- LEFT模式要求有明确左表范围；右表filters在ON中限制合格明细，避免WHERE把无匹配主对象过滤掉。INNER模式保持原语义和参数顺序。
- `group_dataset`和`linked_group_dataset`可传`rowKey`，如`row_key`，为所有分组字段生成确定的组合行键。`null`与空字符串不同。它是程序行标识，不是业务编号；不要把一对象多行强行按对象编号去重。

示意（先核实真实字段与业务规则后替换，不可直接执行）：

```json
{
  "leftTable": "master",
  "rightTable": "detail",
  "join": {"leftColumn": "id", "rightColumn": "master_id", "type": "left"},
  "groupColumns": [
    {"table": "master", "column": "id"},
    {"table": "detail", "column": "month"}
  ],
  "rowKey": "row_key",
  "aggregates": [{"op": "sum", "table": "detail", "column": "amount", "as": "amount"}],
  "filters": [
    {"table": "master", "column": "active", "op": "=", "value": 1},
    {"table": "detail", "column": "deleted", "op": "=", "value": 0}
  ]
}
```

LEFT JOIN会扩展主表行，不能直接累计被重复的左表金额；明细计数应使用右侧实际非空键，不能将COUNT(*)当作匹配明细数。金额null与零不同，不默认补零。

## 日期、精度与核验

MySQL连接启用`dateStrings:true`，保留DATE/DATETIME/TIMESTAMP由数据库返回的字符串，不经开发机时区转换；TIMESTAMP仍有数据库会话时区语义，不能仅凭字符串声称UTC。BIGINT/DECIMAL仍保留精确字符串。不支持的字段类型反馈列名与类型，不输出值，不静默删除列或序列化未知对象。

多行导出用`compose_report`的`keyColumn=row_key`，保留业务编号和月份等展示列。完整范围的独立原始查询采用相同分组字段顺序及rowKey，交给`finalize_report`核对；独立金额汇总基准仍须具备同口径，不能用同一查询或草稿自证。刷新recipe保留rowKey与join.type。

只有来源字段所有引用明确`missing=zero`且有业务依据，来源null才按零参与最终分量合计；基准自身null仍不能猜零。不改变金额精度、文件核验、授权和范围检查。

## 接续与防重复

连续无进展时，最新同环境证据中未解决的三类具体参数失败（字段类型、aggregates形状、关联粒度）可按仍开放的原必需目标定向修正。服务器生成恢复摘要并在状态开始步骤时持久记录；每个问题、环境/查询目标、类别只恢复一次，改写描述或换工具不能重置同类凭证。之后仍重复失败会按原无进展规则停止，保留成果。

执行器错误、超时、权限/范围不足、已解决错误、未知/已核实/可选目标均不能靠该分支绕过。不是取消重复保护，也不新增任务总时限/总轮次上限。恢复后的操作仍逐次验证实际授权与租约。

## 升级与验证

无新依赖、权限或配置。等待在途任务结束，按现有流程备份程序、状态与任务数据后升级，重启控制面和Runner。不要修改旧红卡或自动重跑历史生产任务冒充成功。

回归包括：真实工具适配器的日期选项与精确字符串、SQLite隔离执行参数化关联SQL、68主对象/139明细与37无匹配对象组成176行的全量范围及独立金额核验、默认INNER兼容、未知关联与注入拒绝、状态重启持久去重及租约拒绝。SQLite执行与模拟驱动不是MySQL生产端到端或真实模型规划验收；Windows/Linux另行验收。

当前配置模型另用两种纯合成场景（主对象/月预算与仓库/批次库存）规划回放，均选择显式LEFT关联、月份粒度及组合行键。仅验证工具选择，不连接生产或发送群消息。
