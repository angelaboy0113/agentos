# 自动维护备份整理（1.97.0）

这是独立于业务历史30天保留的本机维护功能。默认关闭；维护者登记并验收后启用。不会创建飞书机器人，不调用模型、不查数据库、不发群消息、不结束用户任务，也不重启服务。

## 入口和配置

在实例的 `runtime/maintenance-cleanup.local.json` 保存配置（0600，父目录0700），示例见 `config/maintenance-cleanup.example.json`。修改时间、启停开关下个一分钟检查周期生效，不需重启。`hour/minute/timeZone` 是本地日历时间；每天到点后尝试一次，忙则延期，错过某天不补跑多次。电脑休眠时不运行，醒来后检查。已完成当天不会因普通重启重复执行。`acceptedRelease` 与实际程序版本一致且尚未处理时，也可在发布验收后触发；只有验收通过的部署才登记该触发器。

`managedRoot` 必须精确为当前实例 runtime/migration；不遍历个人目录、业务仓、凭据或未登记的迁移文件。每个checkpoint登记路径、验收时间、验收证据路径/SHA256。保留最近三个完整点，以及 `pins` 和自动生成的全部恢复锚点。恢复锚点只增不减，轮换须人工迁移索引后验证；本版不自动删除独有历史内容、不转换旧去重索引、不实施内容寻址库。

发布验收并记录真实 `health/ready/backup/commit/version/at` 后，由维护发布流程运行：

```sh
node scripts/maintenance-backups.mjs register-checkpoint /absolute/instance/runtime /absolute/instance/runtime/migration/release/deployed-acceptance.json
```

它只登记该回退点的exports/control-receipts，不登记其配置和凭据。新备份需维护者接入这一验收步骤，不能把任意新目录自动认为可删。普通群成员无需操作。

## 执行与保护

控制面每分钟检查时间。活任务、对话、入站回调、接待、导出与未投递结果均使整理延期。确认为撤回、人工暂停或迁移前遗留不再可投递的精确历史记录，可由维护者在inactiveStateRecords登记整条记录SHA256，仅识别其非活动状态，不改队列或伪造发送成功。内容有任何变化即恢复阻挡，新活任务仍优先阻挡；不能按年龄或错误文字自动排除。

等待审批/补充的原任务与其他现存任务中的路径引用仍保护对应历史目录。每次删除前，使用状态写队列的只读互斥栅栏重新检查最新任务/投递/路径引用；不复制整份状态、不改业务状态。用户新任务优先，下一步整理暂停。

清理只在owner登记的历史bulk目录进行，跨进程锁不自动抢占；崩溃留下锁需维护者确认owner进程确实退出后处理，不能盲删锁。拒绝符号链接根、路径越界、变更的验收证据、打开中的目录、配置变更及不一致签名。候选文件必须在保留回退点相同相对路径找到相同字节数与SHA256的完整普通文件。目录中独有文件、Git/开发目录和链接不删除。

先将压缩恢复清单写盘并fsync文件/目录，再在栅栏内核对源和保留副本签名并unlink。所有被引用的保留点写入 `runtime/maintenance-backups/anchor-pins.json`，不得按时间删除。清单是write-ahead计划，崩溃可能只删了一部分；恢复时核验摘要，不覆盖原文件。

可登记已结束隔离测试的node_modules（不是正在运行程序的依赖）：

```sh
node scripts/maintenance-backups.mjs register-test RUNTIME RUNTIME/migration/isolated-check/node_modules RUNTIME/migration/release/full-check.log
```

要求完整通过的测试证明和依赖树内容摘要，删除前核验、检查打开文件，先移入独立审计隔离目录，再核对树摘要才删除。异常时保留隔离树，按该run里的original路径恢复，不能当垃圾继续清理。重建使用该隔离检出的package-lock执行npm ci。程序不会自动猜测某套测试是否结束。

## 审计、恢复与停用

`runtime/maintenance-backups/status.json` 保存成功日及发布标识；`runtime/migration/backup-maintenance-runs/<时间>/` 保存 gzip计划和结果。health的backupMaintenance只展示运行结果计数，不暴露消息/凭据。logicalBytes表示目录文件减少；observedFreeBytesChange是同期磁盘可用量变化，受APFS共享块及并行系统写入影响，两者不等同。审计本身不按年龄删。

从一份旧压缩清单提取缺失的重复副本：

```sh
node scripts/maintenance-backups.mjs restore-fragments RUNTIME PLAN_GZ NEW_EMPTY_DIRECTORY
```

这是片段恢复：先复制历史备份中保留的独有内容到另一个隔离恢复工作区，再按原bulk相对路径合并提取的重复副本。完整恢复须再核对该版本原始清单全部文件的SHA256，以及原配置、凭据和状态；不能把只提取重复文件称为整机恢复。严禁直接回灌正在运行的data。旧版本维护清单仍用原配套恢复器，所有旧锚点继续固定保留。

停用只需 `enabled:false`；不删除配置、状态、审计和锚点。代码回退前停用，保留新审计与全部锚点；不能倒灌旧业务状态。配置损坏、权限不满足、磁盘不足或校验异常均停止本轮并报告失败，业务服务继续运行。

## 验证边界

回归覆盖三完整点/锚点保护、独有文件、真实gzip恢复、哈希变化、路径/链接/外部打开、跨进程互斥、忙时延期、新任务栅栏、日历幂等和测试依赖变化。macOS本机配置和服务实际验收另记实例记录；lsof、目录fsync及真实恢复在其它OS未验，不宣称跨平台无人值守已通过。未登记目录和完整迁移路径无自动保证。外部飞书实施手册需有维护入口才能同步。
