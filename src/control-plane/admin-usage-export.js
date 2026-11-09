import ExcelJS from 'exceljs';
// Only explicit text/number values: no formulas, hyperlinks, macros, external data or user-chosen paths.
const text=x=>String(x??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
const chunks=value=>{const s=text(value),out=[];for(let i=0;i<s.length;){let end=Math.min(s.length,i+30000);if(end<s.length&&/[\uD800-\uDBFF]/.test(s[end-1]))end--;out.push(s.slice(i,end));i=end;}return out.length?out:[''];};
const timestamp=(s,zone)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(s));
export function usageWorkbook(usage,{person,now=new Date()}={}){
 const book=new ExcelJS.Workbook();book.creator='AgentOS';book.created=now;
 function sheet(name,headers,widths){const s=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});s.columns=headers.map((header,i)=>({header,width:widths[i]??18}));s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2457E6'}};s.getRow(1).height=25;s.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};return s;}
 const labels=new Map(usage.profileOptions.map(p=>[p.key,p.label])),people=usage.ranking.filter(p=>!person||p.key===person);
 const ranks=sheet('积分榜',['排名','人员','积分','公开互动数','话题内追问数','使用助手','最近提问时间'],[10,22,12,16,18,48,24]);
 for(const p of people)ranks.addRow([p.rank,text(p.name),p.points,p.count,p.followups,text(Object.entries(p.profiles).map(([k,v])=>(labels.get(k)??k)+' '+v).join(' · ')),timestamp(p.lastAt,usage.filters.timeZone)]);
 const questions=usage.records.map(r=>chunks(r.question??r.title)),extra=questions.reduce((n,q)=>Math.max(n,q.length),1)-1;
 const detailHeaders=['人员','助手','项目','环境','提问时间','问题内容','类型','积分','话题内追问','当前状态','记录编号'];detailHeaders.push(...Array.from({length:extra},(_,i)=>'问题续文'+(i+2)));let detail=sheet('提问明细',detailHeaders,[22,22,18,14,24,85,18,10,16,18,38]),part=1;
 for(const [index,r] of usage.records.entries()){if(detail.rowCount>=1048576)detail=sheet('提问明细'+(++part),detailHeaders,[22,22,18,14,24,85,18,10,16,18,38]);detail.addRow([text(r.name),text(labels.get(r.profile)??r.profile),text(r.projectId),text(r.sourceEnvironment),timestamp(r.createdAt,usage.filters.timeZone),questions[index][0],text(r.kind),r.points,r.followup?'是':'否',text(r.status),text(r.id),...questions[index].slice(1)]);}
 const info=sheet('统计口径',['项目','内容'],[28,110]);for(const row of [
 ['导出时间',timestamp(now,usage.filters.timeZone)],['时区',usage.filters.timeZone],['开始日期',usage.filters.start||'全部留存日期'],['结束日期（含当天）',usage.filters.end||'全部留存日期'],['统计内容',usage.filters.scope==='all'?'全部公开互动（排除私有和敏感消息）':'有效业务提问与追问'],['管理员',usage.filters.excludeAdmin?'排除':'包含'],['人员合并',usage.filters.grouping==='name'?'同名合并仅用于展示':'按机器人身份'],['助手',usage.selection?.profile||'全部'],['项目',usage.selection?.projectId||'全部'],['群',usage.selection?.chatId||'全部'],['人员',person?people[0]?.name||'无匹配人员':'全部'],['积分规则',usage.pointRule],['本次导出积分',people.reduce((n,p)=>n+p.points,0)],['明细行数',usage.records.length],['留存策略（天）',usage.coverage.retentionDays],['最早留存',usage.coverage.firstAt?timestamp(usage.coverage.firstAt,usage.filters.timeZone):'暂无'],['统计说明',usage.method],['明细文本','问题内容为有效公开消息原文；超长文本按问题续文列分段保留。导出不受页面50行分页截断。积分按留存记录计算，非永久累计账户。']])info.addRow(row.map(x=>typeof x==='number'?x:text(x)));
 for(const s of book.worksheets){s.eachRow((r,n)=>{if(n>1){r.alignment={vertical:'top',wrapText:true};r.height=32;}r.eachCell(c=>{if(typeof c.value==='number')c.numFmt='0';});});s.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};}
 return book;
}
