// A request for an Excel-readable table is different from an explicit workbook contract.
export function reportOutputPolicy(question='') {
 const q=String(question),csvOptIn=/csv.{0,8}(?:也行|也可以|可以|即可|就行|就好)/i.test(q);
 const workbookFeatures=/(?:多个|多张|多份|多)(?:工作表|sheet)|保留(?:单元格)?公式|(?:包含|保留|需要)(?:透视表|图表)|合并单元格|(?:保留|指定|需要)(?:单元格)?(?:样式|颜色|格式)/i.test(q);
 const explicitNative=/(?:\.xls(?:x|m)?\b|xls(?:x|m)?格式|格式.{0,6}xls(?:x|m)?|(?:必须|只能|指定).{0,12}xls(?:x|m)?|(?:不要|不能|不接受|不可用)\s*csv)/i.test(q);
 const csvAcceptable=!workbookFeatures&&(!explicitNative||csvOptIn);
 return {csvAcceptable,reason:csvAcceptable?'普通“Excel/表格/清单”需求可用已核验CSV交付，说明Excel可直接打开，不称它为原生XLSX。':'用户明确要求原生工作簿或CSV不能承载的功能，不能悄悄用CSV替代。'};
}
export function normalizeReportFormatReview(job,result){
 const policy=reportOutputPolicy(job.originalQuestion??job.instruction),a=result?.reportAssessment;
 const file=job.reportFiles?.find(f=>f.id===a?.fileId&&f.filename?.endsWith('.csv')&&/^[a-f0-9]{64}$/.test(f.verificationHash??''));
 if(!policy.csvAcceptable||!file||!a?.issues?.some(i=>i.kind==='current_format'))return result;
 return {...result,outcome:'partial',reportReviewRequired:true,environmentQuery:null,websiteQuery:null,
  summary:'现有CSV可直接用Excel打开，普通Excel清单需求不必转为XLSX；继续核对内容与原要求后交付。',
  reportAssessment:{...a,decision:'needs_review',issues:a.issues.map(i=>i.kind==='current_format'?{...i,kind:'optional_followup',evidence:'CSV兼容Excel，普通表格需求不以XLSX后缀作为交付门槛。'}:i)},
  investigation:{...result.investigation,status:'continue',blocker:null,nextStep:'按CSV可交付的规则审阅实际内容；不要为后缀重复取数或要求管理员新增转换工具。真实数据缺口仍需修正。',goals:(result.investigation?.goals??[]).map(g=>g.id==='original-question'?{...g,status:'open'}:g)}};
}
