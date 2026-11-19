import { createHash } from 'node:crypto';

export const prdStart = /^(?:我(?:想|要|准备)(?:做|写)|(?:新建|发起|创建))\s*PRD(?=$|[\s：:，,。！？])/i;
export const prdExport = /^(?:(?:请|帮我|请帮我)\s*)?(?:导出|生成|发布)(?:这版|当前版|一份)?\s*(?:PRD\s*)?飞书文档[。！!]?$/i;

export function needsPrdAnswer(job) {
  const result = job?.result;
  return job?.prd && job.status === 'awaiting_clarification' && !result?.browserLoginRequired && !result?.modelCapacityWaiting
    && !result?.environmentQuery && !result?.websiteQuery && !result?.environmentSetup && !result?.sourceEnvironmentQuery && !result?.sourceHistoryQuery
    && (!result?.investigation?.blocker || result.investigation.blocker.kind === 'user_input');
}

export function prdGuidance(job) {
  if (!job.prd) return '';
  const exporting = job.prd.exportRevision === job.prd.revision;
  return `
【需求工作台】本题为需求设计及受控只读调查。主需求、用户原话及已存阶段结论以本题为限。
先区分当前行为、目标行为、用户已确认的规则、助手建议和待核实事项。目标不清时先问，工程实现不写入系统。
从本系统界面、接口、权限、字段、状态追到相关系统。每项标记系统、环境、固定提交或受控证据。对方仓库或环境不可用时，写清缺口和需确认的团队，不能自行扩大权限或声称已查。
有跨系统关联时列出双方影响、业务键、失败/延迟/重复、存量、责任方和联调验收。区分用户确认的业务规则与建议。
仅在缺少会改变范围、权限或关键交互的业务决定时，outcome=needs_clarification，investigation.status=wait，blocker.kind=user_input，needed 写清要用户在卡片回答的具体问题，核心目标标 open，本轮不提交文件。非关键未知项列待确认。信息足够则立即制作评审稿，无需用户说导出或确认发布。
${exporting ? `用户授权信息齐备后自动交付飞书评审稿。用 documentRequests 实际提交一个 md 和一个 png。md 使用一级/二级标题、重点加粗、原生可转换的管道表格，至少包含业务目标、范围、双端影响、业务规则、页面设计、验收、待确认、版本。不得宣称未完成的同版评审已通过。末章标题为「原型图」，标注示意图和对应规则编号，图片由交付器插入。png 用原生图片请求。先用对应环境的固定源码定位真实前端路由、组件和实际样式；沿已配置的同系统只读网页打开目标页面并调用 browser_screenshot 保存内部参考。隔离浏览器的脱敏参考会自动传给生图工具；共享浏览器返回实时颜色和布局数据，请把这些实测样式写入生图描述。无需在成品贴原业务截图。严格沿用页面布局、导航、配色和表单/抽屉样式，仅改需求涉及区域。若网页暂不可用，明确说明并逐项从对应前端源码抽取布局、真实颜色与组件样式，在生图描述中写入实际依据，不自行挑通用配色。同环境有两套以上主题且没有证据确定应用哪套时，把主题选择当作具体澄清问题，或在用户已选定参考版本时按所选版本标注出稿。页面和源码都无法形成可信样式基线时，不提交假原型，指出具体缺口，必要时请发起人提供脱敏截图。正文标记采用的页面和/或源码路径及环境，区别实际页面和拟议修改。实际文件都要通过核验。若真实原型偏离源页面，只修订有问题的 PNG 并用 reportAssessment 再审阅；保持核心项 open，待新图核验前不得交付。文字清单和图片只能用已确认信息及明确标为示意的内容。不要给第三方图片URL或嵌入远程内容。不要把账号、凭据、个人资料或生产明文样本写入群共享文档；以脱敏示例和可共享证据定位说明。` : '未要求导出时仅给出本轮影响、决策和待确认事项，不生成最终附件。提示用户在原话题直接补充，或发送「导出飞书文档」。'}`;
}

export function prdDocumentTitle(question, revision) {
  const subject = String(question.title).replace(prdStart, '').replace(/^[\s：:，,。]+/, '');
  return `[${question.id}] ${Array.from(subject || 'PRD').slice(0, 74).join('')} · 评审稿 v0.${revision}`;
}

export const prdIntentDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
