// Route known Feishu resource links to fixed APIs; never fetch arbitrary user URLs.
export function cloudFileLinks(text=''){
 const links=new Map();
 for(const found of String(text).matchAll(/https:\/\/[^\s<>"'\]\u3000]+/gi)){
  const raw=found[0].replace(/[),.;，。；）】]+$/g,'');let u;try{u=new URL(raw);}catch{continue;}
  if(u.username||u.password||u.port||!/(?:^|\.)(?:feishu\.cn|larksuite\.com|larkoffice\.com)$/i.test(u.hostname))continue;
  const m=u.pathname.match(/^\/(?:drive\/)?(file|wiki|docx|doc|sheets|sheet|slides|folder)\/([A-Za-z0-9_-]+)\/?$/i);if(!m)continue;
  const type=m[1].toLowerCase()==='sheets'?'sheet':m[1].toLowerCase();
  const url=u.origin+u.pathname.replace(/\/$/,'');links.set(`${type}:${m[2]}`,{url,type,token:m[2]});
 }return [...links.values()];
}
