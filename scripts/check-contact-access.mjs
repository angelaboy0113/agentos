// Local diagnostic: prints counts and field availability, never names, IDs, tokens or raw responses.
import {LarkCliFeishuClient,runLarkCli} from '../src/control-plane/lark-cli.js';
const position=process.argv.indexOf('--profile'),profile=position>=0?process.argv[position+1]:'';
if(!profile){console.error('Usage: node scripts/check-contact-access.mjs --profile your-owner-profile');process.exitCode=1;}
else try{
 const client=new LarkCliFeishuClient({dataDir:process.env.AGENTOS_DATA_DIR??'./data'}),params={user_id_type:'open_id',department_id_type:'open_department_id',page_size:50};
 const status=await runLarkCli(['api','GET','/open-apis/application/v6/scopes','--as','bot','--json'],{profile});
 const scopes=await client.contactRequest('/open-apis/contact/v3/scopes',params,{profile});
 let user={};if(scopes.user_ids?.[0])user=(await client.contactRequest('/open-apis/contact/v3/users/'+encodeURIComponent(scopes.user_ids[0]),{user_id_type:'open_id',department_id_type:'open_department_id'},{profile})).user??{};
 console.log(JSON.stringify({identity:'bot',contactPermissions:(status.data?.scopes??[]).filter(s=>s.scope_name?.startsWith('contact:')).map(s=>({permission:s.scope_name,granted:s.grant_status===1})),firstScopePage:{users:scopes.user_ids?.length??0,departments:scopes.department_ids?.length??0,groups:scopes.group_ids?.length??0,hasMore:scopes.has_more===true},sampleFieldAvailability:{name:Boolean(user.name),employeeNumber:Boolean(user.employee_no),departments:Boolean(user.department_ids?.length),jobTitle:Boolean(user.job_title),enterpriseEmail:Boolean(user.enterprise_email)},note:'Counts describe first scope page only; no personal data printed, no messages sent, no permission changes.'},null,2));
}catch{console.error('Contact diagnostic failed. Check bot permission, profile and connection locally; raw response omitted.');process.exitCode=1;}
