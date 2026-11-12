# 默认文件设计技能

PPTX 和 HTML/H5 的内容核验、制作和投递仍走原任务文件链路；设计技能改善排版，不增加数据库、网络、业务写入或网站发布权限。

## 入口与运行流程

所有机器人共用 `src/shared/document-design.js`。Runner 每次构造源码/文件执行提示时，按当前用户问题加载发行包中已审阅的 `config/design-skills/pptx/SKILL.md` 或 `frontend-design/SKILL.md`；同时要求两种格式时都加载。修改已交付文件、没有重说格式时，使用本任务已绑定附件或已登记文件的格式。普通业务查询不加载设计长文。显式不要某格式时不为该格式加载技能。

事件 `document_design_loaded` 和执行结果 `designSkills` 保存技能 ID、内容 SHA256、策略版本，可区分“已经安装”和“本任务实际注入”。注入不保证模型完成设计，仍需查看实际文件。附件、业务仓里的 SKILL.md 和用户路径不能替换受信清单。

默认：先确定受众、结构、视觉方向和页数，再在本任务 `working` 构建原生 PPTX 或自包含 HTML；原生文件通过 `documentRequests[].content={artifactFile,sourceFile}` 复制、核验并投递。用户模板、品牌与指定页数优先，没有配置时不把任何真实系统品牌写入通用核心。PPT 优先采用已安装 pptxgenjs，可编辑表格/图表；旧 JSON 配方仍兼容，默认改为封面/正文/独立数据表与长文分页，可选 `theme={accent,ink,background,fontFace}`，颜色为六位十六进制。长表可能自动续页；明确页数需求应由原生文件构建控制，不能默默删行缩表。

H5 是离线 HTML 附件，继续禁用任意脚本、外链资源、网络和表单；可用响应式 CSS、内嵌图片、details 原生交互。前端技能中的部署、CDN、安装包等建议不覆盖执行权限。需要 React/联网服务/公开域名时应说明现有交付边界，不能伪称已托管。

## 安装与迁移

无需新增私有配置或应用权限，正常发行部署后新执行轮默认使用。第三方来源为 [anthropics/skills](https://github.com/anthropics/skills)，Apache-2.0；`upstream.json` 保存获取版本及逐文件摘要，两个目录各保留许可证。发行包带上完整技能目录与资源，不依赖维护者的全局 Codex 技能目录。维护者可以另外全局安装同名技能供交互式 Codex 使用，两者独立；更新全局副本不会静默改变生产。

可选 PPT 预览脚本依赖 Python/LibreOffice 等工具；不因技能存在就假定所有依赖已安装，也不允许运行中的任务自行安装。HTML 的实际渲染继续由可信运行器执行。PPT 应检查实际幻灯片，预览不可用须记录未视觉验收；Office ZIP 结构通过不等于视觉质量通过。设计验收也不能代替业务金额、范围、文件哈希和原话题附件送达核验。

## 验证与排障

执行 `node scripts/test.js test/document-design.test.js test/document-artifacts.test.js test/artifact-workspace.test.js`，核验双系统/双环境选择、无格式追问、普通查询不加载、上游资源摘要、真实 Runner 提示注入、旧配方原生表格/精确值/分页及投递边界。`node scripts/verify-capability-package.mjs` 检查技能资源随包齐全。实际模型制作、视觉预览与群交付应分别记验收，不能仅凭提示里出现技能名判定美观或业务已交付。

新任务无加载事件时，检查当前问句、绑定输入 MIME/格式和发行版本；不要通过读取其它任务文件补猜。文件失败继续原任务工作区和既有证据，不重新查询业务。回退保留当前数据、凭据与产物；旧 JSON 配方仍可读取，原生产物收据兼容规则不变。其他操作系统及完整跨机迁移需单独验证。
