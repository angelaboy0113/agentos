import { createHash } from 'node:crypto';

export const prdStart = /^(?:我(?:想|要|准备)(?:做|写)|(?:新建|发起|创建))\s*PRD(?=$|[\s：:，,。！？])/i;
export const prdExport = /^(?:(?:请|帮我|请帮我)\s*)?(?:导出|生成|发布)(?:这版|当前版|一份)?\s*(?:PRD\s*)?飞书文档[。！!]?$/i;

export function prdGuidance(job) {
  if (!job.prd) return '';
  const exporting = job.prd.exportRevision === job.prd.revision;
  return `
【需求工作台】本题为需求设计及受控只读调查。主需求、用户原话及已存阶段结论以本题为限。
先区分当前行为、目标行为、用户已确认的规则、助手建议和待核实事项。目标不清时先问，工程实现不写入系统。
从本系统界面、接口、权限、字段、状态追到相关系统。每项标记系统、环境、固定提交或受控证据。对方仓库或环境不可用时，写清缺口和需确认的团队，不能自行扩大权限或声称已查。
有跨系统关联时列出双方影响、业务键、失败/延迟/重复、存量、责任方和联调验收。区分用户确认的业务规则与建议。
每轮优先问少量会改变业务行为的具体问题，保留决策和未决项。对话阶段完成本轮梳理后用 ready，等待用户继续由工作台接管。完成本轮不等于需求已评审通过。
${exporting ? `本轮用户明确要求导出飞书文档。用 documentRequests 实际提交一个 md 和一个 png。md 使用一级/二级标题、重点加粗、原生可转换的管道表格，至少包含业务目标、范围、双端影响、业务规则、页面设计、验收、待确认、版本。不得宣称未完成的同版评审已通过。末章标题为「原型图」，标注示意图和对应规则编号，图片由交付器插入。png 用原生图片请求，画清现有/改版位置、主要状态和交互；无真实截图时标注概念原型。实际文件都要通过核验。文字清单和图片只能用已确认信息及明确标为示意的内容。不要给第三方图片URL或嵌入远程内容。不要把账号、凭据、个人资料或生产明文样本写入群共享文档；以脱敏示例和可共享证据定位说明。` : '未要求导出时仅给出本轮影响、决策和待确认事项，不生成最终附件。提示用户在原话题直接补充，或发送「导出飞书文档」。'}`;
}

export function prdDocumentTitle(question, revision) {
  const subject = String(question.title).replace(prdStart, '').replace(/^[\s：:，,。]+/, '');
  return `[${question.id}] ${Array.from(subject || 'PRD').slice(0, 74).join('')} · 评审稿 v0.${revision}`;
}

export const prdIntentDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
