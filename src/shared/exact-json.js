// JSON data parser with numeric lexemes retained verbatim as text. No eval,
// prototype lookup, lossy floating point, silent duplicate keys or code paths.
export function parseExactJson(text){
 const bad=(reason='syntax')=>{throw Object.assign(new Error('JSON格式无效或对象键重复；不能静默丢弃、补零或保留最后一个重复值'),{code:'REPORT_INPUT',jsonReason:reason});};
 if(typeof text!=='string')bad();let p=0;
 const ws=()=>{while(/[\x20\t\r\n]/.test(text[p]??'')&&p<text.length)p++;};
 const string=()=>{const start=p++;while(p<text.length){const c=text[p++];if(c==='"'){try{return JSON.parse(text.slice(start,p));}catch{bad();}}if(c==='\\'){p++;}else if(c<' ')bad();}bad();};
 const value=()=>{ws();const c=text[p];if(c==='"')return string();if(c==='['){p++;ws();const out=[];if(text[p]===']'){p++;return out;}for(;;){out.push(value());ws();if(text[p++]===']')return out;if(text[p-1]!==',')bad();}}
  if(c==='{'){p++;ws();const out={},seen=new Set();if(text[p]==='}'){p++;return out;}for(;;){ws();if(text[p]!=='"')bad();const key=string();if(seen.has(key))bad('duplicate_key');seen.add(key);ws();if(text[p++]!==':')bad();Object.defineProperty(out,key,{value:value(),enumerable:true,writable:true,configurable:true});ws();if(text[p++]==='}')return out;if(text[p-1]!==',')bad();}}
  for(const [token,result]of [['true',true],['false',false],['null',null]])if(text.startsWith(token,p)){p+=token.length;return result;}
  const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(p));if(number){p+=number[0].length;return number[0];}bad();
 };const out=value();ws();if(p!==text.length)bad();return out;
}
