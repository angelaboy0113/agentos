const bad=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};

// Civil calendar keys have no timezone. Timestamps require a separate explicit interpretation.
export function normalizeCalendarPeriod(value,unit){
 const text=typeof value==='string'?value.trim():Number.isSafeInteger(value)?String(value):'';
 if(!['month','day'].includes(unit))bad('日历规范化必须明确month或day粒度');
 const match=unit==='month'?text.match(/^(\d{4})(\d{2})$/)??text.match(/^(\d{4})-(\d{1,2})$/):text.match(/^(\d{4})(\d{2})(\d{2})$/)??text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(!match||Number(match[1])<1)bad('来源期间格式无效：月支持YYYYMM、YYYY-MM、YYYY-M；日支持YYYYMMDD或YYYY-MM-DD；不能当作无发生额补零');
 const canonical=match.slice(1).map(v=>v.padStart(2,'0')).join('-');
 const date=new Date(canonical+(unit==='month'?'-01':'')+'T00:00:00Z');
 if(!Number.isFinite(+date)||date.toISOString().slice(0,unit==='month'?7:10)!==canonical)bad('来源期间日期不存在，不能按范围外排除或补零');
 return canonical;
}
