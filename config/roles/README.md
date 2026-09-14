# AgentOS 角色约束

工程依据：[AI 开发规范](https://weilongmeiwei.feishu.cn/wiki/MDHbwEZSKi1kifk8zKvcm18Dnpg)，原文不由 AgentOS 修改。STO 为 SDD + TDD + ODD（可观测性驱动开发）。

`../harness.json` 记录来源版本；`common.md` 与岗位文件组成规范包。任务执行前加载并计算指纹，链中途变化拒绝自动继续。结果必须有 `handoff`，Runner 校验真实工件范围及必需验收状态，不将 AI 自报结果当成独立测试证明。聊天仍走只读协议，人工审批保留。详见 `docs/harness-integration.spec.md`。

本目录是各 Agent 角色执行约束的可编辑真源。Runner 在每个任务阶段启动 `codex exec` 前，会读取与阶段同名的 Markdown 文件，并和任务信息、前序阶段结果、仓库 `AGENTS.md` 共同组成执行提示词。

- `owner_intake.md`：项目负责人受理与需求澄清
- `pm.md`：PRD、Spec 与验收标准
- `developer.md`：开发实现与自测
- `qa.md`：独立测试与缺陷结论
- `owner_audit.md`：独立审计与放行建议
- `owner_report.md`：最终汇报
- `analysis.md`：taskIntent=analysis 的只读调查职责（保留分配的开发/测试/审计角色，不套实施或受理流程）
- `analysis_report.md`：analysis 的负责人汇总，仅要求调查证据，不要求完整研发交付材料

飞书机器人身份与角色的映射仍在 `../agents.local.json`；工作流顺序在 `src/shared/protocol.js`；项目级工程规范在目标仓库的 `AGENTS.md`。
