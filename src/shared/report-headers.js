// Presentation only: business translations come from project evidence, never a global field dictionary.
const chinese=/[\u3400-\u9fff]/;
export function readableHeadersRequired(question=''){
 if(!chinese.test(question))return false;
 // Only an explicit positive request for original/English headers changes the default.
 const clauses=question.split(/[，。；,;\n]/);
 return !clauses.some(c=>!/(?:不要|不需要|不能|别|禁止|无需|不是|看不懂)/.test(c)&&/(?:表头|列名|字段名)\s*(?:请|要求)?(?:使用|用|保留|保持|采用|只要|要)\s*(?:原始|英文)|(?:请|要|使用|用|保留|保持|采用|只要)(?:纯|原始)?(?:英文表头|英文列名|原始字段名)/.test(c));
}
export function validateReportHeaders(headers,question){
 if(readableHeadersRequired(question)&&headers.some(h=>!chinese.test(h)))throw new Error('中文业务导出须使用可读表头：提供有源码/字段说明依据的中文label，或displayName生成“中文（原英文字段）”；不要重查数据，不要猜测字段含义。只有用户明确要求原始/英文表头才保留纯英文字段名。');
}
export function reportColumns(columns,question){
 const result=columns.map(c=>{
  if(typeof c?.label!=='string'||!c.label.trim())throw new Error('label须为非空字段名或标题');
  if(c?.displayName!==undefined&&(typeof c.displayName!=='string'||!chinese.test(c.displayName)||c.displayName.trim().length>60))throw new Error('displayName须为有依据的中文名称，至多60字符');
  return c?.displayName&&!chinese.test(c.label)?{...c,label:`${c.displayName.trim()}（${c.label}）`}:c;
 });
 validateReportHeaders(result.map(c=>c?.label??''),question);return result;
}
