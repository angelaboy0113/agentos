import test from 'node:test';
import assert from 'node:assert/strict';
import {reportOutputPolicy,normalizeReportFormatReview} from '../src/shared/report-output-policy.js';
test('ordinary Excel requests permit verified CSV, explicit workbook requirements remain binding',()=>{
 for(const q of ['整理成Excel发给我','导出客户清单','发个excel表格','最好xlsx，CSV也可以'])assert.equal(reportOutputPolicy(q).csvAcceptable,true,q);
 for(const q of ['必须是.xlsx文件','请给.xls文件','不要CSV，给我Excel文件','导出带多个工作表的Excel','保留单元格公式'])assert.equal(reportOutputPolicy(q).csvAcceptable,false,q);
});
test('format-only objections request a normal review instead of conversion; real missing content stays blocked',()=>{
 const job={originalQuestion:'整理成Excel发给我',reportFiles:[{id:'file',filename:'file.csv',verificationHash:'a'.repeat(64)}]};
 const r={outcome:'blocked',reportAssessment:{fileId:'file',decision:'revise',coverage:'incomplete',issues:[{kind:'current_format',evidence:'only CSV, not XLSX'}]},investigation:{status:'blocked',goals:[{id:'original-question',required:true,status:'failed'}]},environmentQuery:{}};
 const n=normalizeReportFormatReview(job,r);assert.equal(n.outcome,'partial');assert.equal(n.environmentQuery,null);assert.equal(n.reportAssessment.issues[0].kind,'optional_followup');assert.equal(n.investigation.goals[0].status,'open');
 assert.equal(normalizeReportFormatReview({...job,originalQuestion:'必须.xlsx文件'},r),r);
 const mixed=normalizeReportFormatReview(job,{...r,reportAssessment:{...r.reportAssessment,issues:[...r.reportAssessment.issues,{kind:'current_formula',evidence:'15 rows have missing effective values'}]}});assert.ok(mixed.reportAssessment.issues.some(i=>i.kind==='current_formula'));
 const real={...r,reportAssessment:{...r.reportAssessment,issues:[{kind:'required_output',evidence:'missing required data'}]}};assert.equal(normalizeReportFormatReview(job,real),real);
});
