import test from'node:test';import assert from'node:assert/strict';import{investigateEnvironment}from'../src/runner/environment-investigator.js';import{planQuery}from'../src/shared/environment-access.js';
const entry={projectId:'demo',kind:'mysql',tier:'prd',host:'fixture',port:3306,database:'fixture',credentialRef:'fixture',membersRead:true,ownerOpenIdsByProfile:{demo:[]},queries:{investigate:{mode:'investigate',reviewed:true,description:'Synthetic read',tables:['objects'],maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]}}};
for(const guessed of ['read','delete'])test(`unexecuted guessed tool ${guessed} returns correction without expanding scope`,async()=>{
 const cfg={version:1,environments:{demo:structuredClone(entry)}},plan=planQuery(cfg,{environmentId:'demo',queryId:'investigate',parameters:['Read target object']},'demo',{profile:'demo',senderId:'owner'}),calls=[];let round=0;
 const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({password:'synthetic'}),tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async(tool,args)=>{calls.push(tool);if(tool==='select')assert.deepEqual(args,{table:'objects'});return{rows:tool==='select'?[{id:'one'}]:[]};},close:async()=>{}}),planner:async()=>({next:async input=>{round++;if(round===1)return{tool:guessed,arguments:'{}'};if(round===2){assert.ok(input.tools.some(x=>x.tool==='select'));assert.equal(input.results.at(-1).error.code,'TOOL_ARGUMENTS');assert.equal(input.results.at(-1).executed,false);return{tool:'select',arguments:'{"table":"objects"}'};}return{tool:'finish',arguments:'{}',complete:true,summary:'Verified fixture'};},close:async()=>{}})});
 assert.deepEqual(calls,['connection','select']);assert.equal(result.partial,false);assert.equal(result.toolInputErrors.find(x=>x.tool==='tool_selection').resolved,true);
});
test('correction does not bypass scope revocation before the next tool',async()=>{const cfg={version:1,environments:{demo:structuredClone(entry)}},plan=planQuery(cfg,{environmentId:'demo',queryId:'investigate',parameters:['Read target']},'demo',{profile:'demo',senderId:'owner'});let reads=0,next=0;const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({password:'synthetic'}),tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{if(tool==='select')reads++;return{};},close:async()=>{}}),planner:async()=>({next:async()=>{if(next++===0){cfg.environments.demo.membersRead=false;return{tool:'read',arguments:'{}'};}return{tool:'finish',arguments:'{}',summary:'Scope changed',complete:false};},close:async()=>{}})});assert.equal(reads,0);assert.equal(result.partial,true);});
test('identical unexecuted selection repetition preserves evidence and terminates the no-progress path',async()=>{const cfg={version:1,environments:{demo:structuredClone(entry)}},plan=planQuery(cfg,{environmentId:'demo',queryId:'investigate',parameters:['Read target']},'demo',{profile:'demo',senderId:'owner'});let calls=0;const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({password:'synthetic'}),tools:async()=>({spec:[{tool:'connection'}],run:async()=>{calls++;return{};},close:async()=>{}}),planner:async()=>({next:async input=>input.tools.length?{tool:'nonexistent',arguments:'{}'}:{tool:'finish',arguments:'{}',complete:false,summary:'Tool selection unresolved'},close:async()=>{}})});assert.equal(calls,1);assert.equal(result.partial,true);assert.equal(result.failure.code,'TOOL_SELECTION_REPEAT');});

test('real MySQL premature-finish feedback can be shut down without a coroutine deadlock',async()=>{
 const {InvestigationToolChannel}=await import('../src/runner/investigation-tool-channel.js');const channel=new InvestigationToolChannel(),cfg={version:1,environments:{demo:structuredClone(entry)}},plan=planQuery(cfg,{environmentId:'demo',queryId:'investigate',parameters:['Read full report']},'demo',{profile:'demo',senderId:'owner'});let closed=false;
 const running=investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>({password:'synthetic'}),tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async()=>({connected:true}),close:async()=>{closed=true;}}),planner:async()=>channel.planner()}).then(r=>{channel.settle(r);return r;},e=>{channel.fail(e);throw e;});
 await channel.observe();const rejected=await channel.choose({tool:'finish',arguments:'{}',complete:false,summary:'Need remaining data'});assert.equal(rejected.state,'tools');assert.equal(rejected.input.results.at(-1).error.code,'PREMATURE_FINISH');await channel.stop();const result=await running;assert.equal(closed,true);assert.equal(result.partial,true);assert.ok(result.steps.some(x=>x.includes('connection')));
});

test('typed CSV append errors return actionable diagnostics and keep the tool catalog for correction',async()=>{
 const {QueryInputError}=await import('../src/runner/environment-tools.js');
 const cfg={version:1,environments:{demo:structuredClone(entry)}},plan=planQuery(cfg,{environmentId:'demo',queryId:'investigate',parameters:['Append field']},'demo',{profile:'demo',senderId:'owner'});
 let round=0,applied=0;
 const result=await investigateEnvironment(plan,async()=>{},{
  load:async()=>cfg,credential:async()=>({password:'synthetic'}),
  tools:async()=>({spec:[{tool:'connection'},{tool:'append_report_columns'}],close:async()=>{},
   run:async(tool,args)=>{
    if(tool==='connection')return{connected:true};
    if(args.attachmentId==='raw')throw new QueryInputError('REPORT_INPUT','请使用已绑定原文件');
    applied++;
    return {exportFile:{id:'test-file',sha256:'digest'}};
   }}),
  planner:async()=>({close:async()=>{},next:async input=>{
   assert(input.tools.some(t=>t.tool==='append_report_columns'));
   if(round++===0)return{tool:'append_report_columns',arguments:'{"attachmentId":"raw"}'};
   assert.match(input.results.at(-1).error.message,/请使用已绑定原文件/);
   return{tool:'append_report_columns',arguments:'{"attachmentId":"verified"}'};
  }}),
 });
 assert.equal(applied,1);
 assert.equal(result.partial,false);
 assert.equal(result.toolInputErrors.find(e=>e.tool==='append_report_columns').resolved,true);
});
