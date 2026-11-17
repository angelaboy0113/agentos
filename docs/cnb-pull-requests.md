# CNB 合并请求只读调查

适用于询问“谁提交、谁合并、什么时候关闭、某分支有哪些合并事项”的调查。它与源码提交、构建记录使用分别审核的资源和凭据；令牌需要原组织或仓库范围的 `repo-pr:r`，不需要写权限或网页登录。源码作者、平台合并者、需求负责人和上线时间不能互相替代。

## 配置及入口

环境类型仍为 `cnb`，新增可选 `cnb.resources`。缺省兼容既有 `build-history`。每个入口只选择一种资源，避免构建与合并请求混用令牌。精确仓库、项目、tier、审批主体及工具运行授权继续生效；配置变化会使旧授权失效，不扩大当前任务权限。

```json
{
  "kind": "cnb", "projectId": "your-project", "tier": "uat",
  "credentialRef": "your-pr-read-credential", "membersRead": true,
  "ownerOpenIdsByProfile": {"your-bot": ["your-admin-open-id"]},
  "cnb": {"apiOrigin": "https://api.cnb.cool", "resources": ["pull-requests"]},
  "queries": {"investigate": {
    "mode": "investigate", "reviewed": true,
    "description": "合并请求只读目录；平台操作者和关闭时间，不是部署时间",
    "parameters": [{"name":"purpose","type":"string"}],
    "repositories": ["your-org/your-project/your-repository"],
    "maxRows": 100, "timeoutMs": 600000
  }}
}
```

凭据通过本机隐藏录入保存到受控加密库，不放进示例、模型或日志。部署团队自己的环境配置变更按其维护流程安装并重启，在应用目录以实际配置路径运行 `loadEnvironments` 验证。代码无需额外依赖。迁移包必须包含新模块、配置示例、本说明及回归；加密凭据和真实环境配置继续仅进入私有迁移。

## 工具及证据

- `connection`：真实读取一条合并请求，不能以登记目录冒充权限通过。
- `pull_request`：指定仓库和编号读取平台投影；不读原始正文、评论或外部链接。
- `pull_requests`：显式分页，依据真实 `x-cnb-page`、`x-cnb-page-size`、`x-cnb-total` 检查覆盖；按 `nextPage` 读取至空终页。
- `pull_request_index`：默认本次配置范围全部仓库，也可明确子集；最多四个仓库的 I/O 并发，一次模型工具调用读取全目录，减少网页与模型往返。可在读取后按精确目标分支筛选。没有新增总任务、仓库数或总页数截止。

批量目录逐仓保留开始/结束时间、完整性和失败码。临时网络、响应流中断或429/502/503/504只重试同一幂等GET并重验授权；403缺权限不重放登录。空终页返回total=0时仅在已读数量已匹配前页声明总数的情况下兼容；真正总数变化、重复页、缺页、跨仓库身份、无效编号/日期均不能当作空结果；完整仓与失败仓独立保留。大结果按原工具结果持久化、跨阶段读取和文件核验规则处理。

`mergedBy` 只有 `isMerged=true` 才表示平台合并操作者；`author` 是发起者。当前验证接口提供 `closed_at`，未提供独立 `merged_at`，所以 `mergeTime` 明确为 null，展示为“平台关闭时间（已合并）”，不能把它、Git提交时间或构建时间冒充精确部署时间。PR标题仅是事项线索，不证明正式需求归属。目标分支PR目录必须继续与任务固定SHA的Git祖先证据关联，不能把后来合入的PR算进旧快照。

## 验收与恢复

测试 `test/cnb-pull-requests.test.js` 覆盖旧构建兼容、身份/环境精确范围、分页、去重、动态总数、权限/流中断、四路I/O、只读边界、时间含义和关闭后拒绝调用。真实实例还需用本部署凭据做原生API读取、同题真人新卡及文件/完成提醒验收；单元测试不代表整题性能。回退前自然空闲并停用整个新PR入口，保留运行数据及凭据；旧版本不认识resources，不能只删resources将PR入口伪装成构建入口。不倒灌旧agentos.json。
