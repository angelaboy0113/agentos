// Explicit command grammar, not natural-language intent inference. Execution still
// goes through validateDecision, the contact policy and private channel guards.
export function departmentCommand(content){
 if(typeof content!=='string')return null;
 const match=/^\/部门人数(?:\s+([\s\S]*))?$/.exec(content.trim());if(!match)return null;
 const query=match[1]?.trim()??'';
 return {action:query?'lookup_contact':'reply',intent:'none',reply:query?'正在核对指定部门的直属及含下级人数。':'请使用 /部门人数 完整部门路径，例如：/部门人数 销售中心--渠道运营部。',instruction:'',jobId:'',projectId:'',attachmentIds:[],requiresSourceInspection:false,requiresFileInspection:false,sourceEnvironment:'',environmentQuery:null,environmentSetup:null,knowledgeMatch:null,contactLookup:query?{type:'department',query,candidateId:''}:null,timing:{mode:'explicit-department-command',aiMs:0}};
}
