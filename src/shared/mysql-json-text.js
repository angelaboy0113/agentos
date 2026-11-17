import {parseExactJson} from './exact-json.js';
const sensitive=/password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
// Keep numeric lexemes verbatim; JSON.parse/stringify can round IDs and amounts.
export function mysqlJsonText(text){
 parseExactJson(text);let p=0;
 const ws=()=>{while(/\s/.test(text[p]??'')&&p<text.length)p++;};
 const string=()=>{const start=p++;while(p<text.length){const c=text[p++];if(c==='"')return text.slice(start,p);if(c==='\\')p++;}};
 const value=()=>{ws();const c=text[p];if(c==='"')return string();
  if(c==='['){p++;ws();const parts=[];if(text[p]===']'){p++;return '[]';}for(;;){parts.push(value());ws();if(text[p++]==']')return '['+parts.join(',')+']';}}
  if(c==='{'){p++;ws();const parts=[];if(text[p]==='}'){p++;return '{}';}for(;;){ws();const key=string();ws();p++;const v=value();if(!sensitive.test(JSON.parse(key)))parts.push(key+':'+v);ws();if(text[p++]==='}')return '{'+parts.join(',')+'}';}}
  const start=p;while(p<text.length&&!/[\s,}\]]/.test(text[p]))p++;return text.slice(start,p);
 };return value();
}
