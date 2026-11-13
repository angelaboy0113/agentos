import {currentUserQuestion} from './user-request-scope.js';
// Unknown, amount, breakdown, ranking and explicit file requests retain intake.
export function countAnswerOnly(job){
 const text=String(currentUserQuestion(job));
 if(!text||/(?:导出|下载|清单|明细|逐[条店户人项]|每[个家位月日天周]|排名|排行|趋势|分别列|按.{0,12}(?:分组|汇总|统计)|金额|费用|余额|销售额|预算|制作|生成|文件|附件|报表|表格|excel|csv|xlsx|ppt|word|html|h5|pdf|json|zip|export|download|breakdown|ranking)/i.test(text))return false;
 return /(?:多少[家个人条项]?|几[家个人条项]|数量|总数|门店数|客户数|人数|how many|count of)/i.test(text);
}
export function requiresTabularFile(job){return job.tabularDelivery===true&&!countAnswerOnly(job);}
