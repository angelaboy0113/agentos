# 已交付 CSV 补列与年月格式

版本1.76.0，2026-11-06。用于已有完整CSV后继续要求“增加日期/月度/组织等来源字段并重新生成文件”。无需新增配置或依赖。仍只使用当前任务、原机器人/群/系统/环境、已批准的数据来源；不开放任意SQL、脚本或跨系统数据，不修改业务库。

1. 从本问题可见链的deliveredFiles选原attachmentId，Runner可读取完整CSV。
2. 环境工具`import_task_input`选择原CSV关联键的0-based列索引；CSV首行是已有表头，不作为数据。保留字符串、前导零、空串、重复与原行序，独立input_row只是行号。原生云表格旧导入规则保持。
3. `collect_dataset_values`从完整输入建立in_set，仅在当前已批准库补取新增字段；已有完整补充数据直接恢复。不因为CSV有43列而重新查询43列，也不逐行查询。
4. `append_report_columns`按原CSV表头leftKey与完整补充数据rightKey进行左关联，保留原文件每一行和每一个旧单元格。右键必须唯一且非空，安全整数键可转换为精确字符串，原CSV的前导零不被删除；类型转换后重复仍报错。未匹配、真实空值和范围外记录分别显式指定error/empty或error/exclude，不补假零、不静默取第一条、不丢原行。

```json
{
  "attachmentId": "从当前已交付文件目录选择",
  "datasetRef": "当前任务完整补查数据集",
  "leftKey": "对象编号",
  "rightKey": "object_id",
  "columns": [{"column": "expected_date", "label": "期望月份", "format": {"kind": "month_compact", "inputType": "civil_datetime"}}],
  "missing": "error",
  "nulls": "empty",
  "outside": "error",
  "requirement": "保留原有列和行序，仅追加期望月份"
}
```

格式可省略以保留来源字符串。month_compact输出六位yyyyMM；month输入接受202601、数值202601、2026-01、2026-1；civil_day接受YYYYMMDD/明确YYYY-MM-DD；civil_datetime接受无时区的YYYY-MM-DD HH:mm:ss或T分隔及小数秒。跨年、闰日、小时/分/秒均验证；带时区时间戳、未知数值时间戳或格式歧义必须先明确解释，不猜测。格式错误先报错，即使记录在范围外，也不能过滤后补空。不能用SQL字符串转换权限缺失作为无法转换的理由。

此入口只直接补充来源字段和显式日期格式，不提供任意单元格改值或金额公式。新增普通数值/金额列须沿既有完整数据和独立核验流程；显式数字月份是日期格式处理，不当金额求和。

新文件保存revision version=2的来源文件、补充datasetRef/scope/dataHash/readAt和固定配方。inspect_report重开源文件、校验完整数据集并逐格重放，检查旧单元格、原行序、关联覆盖及实际新CSV。原文件、补充字段分别保留取数时间，跨轮不是同事务；不悄悄刷新旧列。生成后仍交由源码审阅及既有ReportDelivery发送，不能用复制未改变原文件当作补列完成。revise_report_file会返回changed=false，执行器不因此自动结束文件修改子步骤。

迁移保留原文件与核验记录、整个任务datasets/exports、问题/回执及附件引用；活动依赖受现有清理图保护。缺少来源或摘要不符应报告真实缺口，不猜测重建。旧revision=1继续可读；新记录不能由缺少version=2读取能力的旧程序继续修订，回退应保留新读取兼容。

回归覆盖两个系统和PRD/SIT隔离、SQL/Mongo工具目录与实际CSV输入导入、原行/重复/空值/大数文本、混合月份、跨年/闰日/非法值/时区拒绝、关联重复及范围外、原件不变、新文件重开及依赖篡改拒绝、无改动文件的完成判断。真实业务补列及平台投递在实例私有维护证据中另行记录；Windows、原生XLSX/格式/多工作表及整套跨机迁移未据此宣称验证。
