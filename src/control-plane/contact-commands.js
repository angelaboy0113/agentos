// Explicit command grammar, not natural-language intent inference. Execution still
// goes through validateDecision, the contact policy and private channel guards.
export function departmentCommand(content){
 if(typeof content!=='string')return null;
 const person=/^\/同部门(?:\s+([\s\S]*))?$/.exec(content.trim());
 if(person){const text=person[1]?.trim()??'';const query=text.replace(/^(?:姓名|工号)\s+/,'');const type=/^姓名\s+/.test(text)?'department_of_name':/^工号\s+/.test(text)||/^\d+$/.test(query.normalize('NFKC'))?'department_of_employee_no':'department_of_name';return {action:query?'lookup_contact':'reply',intent:'none',reply:query?'正在核对这位同事当前所属部门的成员名单。':'请使用 /同部门 工号 或 /同部门 姓名 同事姓名。',instruction:'',jobId:'',projectId:'',attachmentIds:[],requiresSourceInspection:false,requiresFileInspection:false,sourceEnvironment:'',environmentQuery:null,environmentSetup:null,knowledgeMatch:null,contactLookup:query?{type,query,candidateId:''}:null,timing:{mode:'explicit-department-command',aiMs:0}};}
 const match=/^\/(?:部门人数|部门成员)(?:\s+([\s\S]*))?$/.exec(content.trim());if(!match)return null;
 const query=match[1]?.trim()??'';
 return {action:query?'lookup_contact':'reply',intent:'none',reply:query?'正在核对指定部门的成员及直属、含下级人数。':'请使用 /部门人数 完整部门路径，例如：/部门人数 销售中心--渠道运营部。',instruction:'',jobId:'',projectId:'',attachmentIds:[],requiresSourceInspection:false,requiresFileInspection:false,sourceEnvironment:'',environmentQuery:null,environmentSetup:null,knowledgeMatch:null,contactLookup:query?{type:'department',query,candidateId:''}:null,timing:{mode:'explicit-department-command',aiMs:0}};
}
