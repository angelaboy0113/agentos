import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseEndpoints } from '../src/runner/config-endpoints.js';
import { createEnvironmentTools, selectStatement, QueryInputError } from '../src/runner/environment-tools.js';
import { validateToolQuery } from '../src/shared/environment-tool-policy.js';
import { planQuery } from '../src/shared/environment-access.js';
import { fitToolResult, investigateEnvironment } from '../src/runner/environment-investigator.js';
const credentials = { username: 'fake-user', password: 'fake-secret' };
const query = { mode: 'investigate', reviewed: true, description: '只读排查', namespaces: ['uat'], tables: ['orders'], maxCalls: 6, maxRows: 5, timeoutMs: 1000, parameters: [{ name: 'purpose', type: 'string' }] };
const environment = { kind: 'nacos', projectId: 'demo', tier: 'uat', credentialRef: 'fake', baseUrl: 'http://localhost:8848/nacos', ownerOpenIdsByProfile: { owner: ['ou_admin'] }, membersRead: true, queries: { investigate: query } };
test('YAML references resolve host port database without exposing credentials', () => {
  const rows = databaseEndpoints('commons:\n  mysql:\n    host: db.example\n    port: 3306\n    db: demo\n    password: fake-secret\nspring:\n  url: jdbc:mysql://${commons.mysql.host}:${commons.mysql.port}/${commons.mysql.db}?password=${commons.mysql.password}\n');
  // Query options containing credential references are irrelevant to endpoint extraction.
  assert.equal(rows.length, 1); assert.equal(rows[0].host, 'db.example'); assert.equal(rows[0].port, 3306); assert.equal(rows[0].database, 'demo'); assert.doesNotMatch(JSON.stringify(rows), /fake-secret|password/);
});
test('unresolved and cyclic references are explicit partial results, not fabricated endpoints', () => {
  for (const source of ['url: jdbc:mysql://${missing}/demo', 'a: ${b}\nb: ${a}\nurl: jdbc:mysql://${a}/demo', 'password: host\nurl: jdbc:mysql://${password}/demo']) {
    const rows = databaseEndpoints(source); assert.equal(rows.length, 0); assert.equal(rows.unresolved, true);
  }
  assert.throws(() => databaseEndpoints('a: &a [1]\nb: *a'));
  assert.throws(() => databaseEndpoints('url: !!js/function x'));
});
test('Nacos tools expose only allowed namespace metadata and parsed results', async () => {
  const calls = []; const tools = await createEnvironmentTools(environment, query, credentials, { fetch: async url => {
    url = new URL(url); calls.push(url);
    if (url.pathname.endsWith('/auth/login')) return JSON.stringify({ accessToken: 'fake-token' });
    if (url.pathname.endsWith('/history/configs')) { assert.equal(url.searchParams.get('namespaceId'), 'uat'); return JSON.stringify({ code: 0, data: [{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', content: 'fake-secret' }] }); }
    assert.equal(url.searchParams.get('tenant'), 'uat'); return 'url: jdbc:mysql://db.example/demo?password=fake-secret';
  } });
  await tools.run('connection'); const listed = await tools.run('discover'); assert.doesNotMatch(JSON.stringify(listed), /fake-secret|fake-token/);
  await assert.rejects(tools.run('read_config', { ref: 'foreign' }));
  const result = await tools.run('read_config', { ref: listed.configs[0].ref }); assert.equal(result.rows[0].database, 'demo');
  await assert.rejects(tools.run('delete', {})); await tools.close(); assert.ok(calls.every(x => x.host === 'localhost:8848'));
});
test('dynamic query builder only permits actual scoped fields and bound filters', () => {
  const tables = new Map([['orders', ['id','status','password']]]);
  const args = { table: 'orders', columns: ['status'], filters: [{ column: 'id', op: '=', value: "x' OR 1=1" }] };
  const s = selectStatement(args, tables, query); assert.doesNotMatch(s.sql, /OR 1=1/); assert.equal(s.params[0], "x' OR 1=1");
  for (const bad of [{ ...args, columns: ['password'] }, { ...args, table: 'users' }, { ...args, columns: ['SLEEP(5)'] }, { ...args, filters: [] }, { ...args, filters: [{ column: 'id', op: '= 1;DELETE', value: 1 }] }]) assert.throws(() => selectStatement(bad, tables, query));
});
test('dynamic query builder supports bounded parameterized contains and in filters', () => {
  const tables = new Map([['logs', ['oper_param','status','id']]]);
  const scopedQuery = {...query,tables:['*']};
  const contains = selectStatement({ table:'logs', columns:['status'], filters:[{ column:'oper_param', op:'contains', value:'2102210708288290818' }] }, tables, scopedQuery);
  assert.match(contains.sql, /LOCATE\(\?, `oper_param`\) > 0/);
  assert.deepEqual(contains.params, ['2102210708288290818']);
  const many = selectStatement({ table:'logs', columns:['status'], filters:[{ column:'id', op:'in', value:['one','two'] }] }, tables, scopedQuery);
  assert.match(many.sql, /`id` IN \(\?, \?\)/);
  assert.deepEqual(many.params, ['one','two']);
  for (const filters of [
    [{ column:'oper_param', op:'contains', value:'' }],
    [{ column:'id', op:'in', value:[] }],
    [{ column:'id', op:'in', value:Array.from({length:101},(_,i)=>i) }],
  ]) assert.throws(() => selectStatement({ table:'logs', columns:['status'], filters }, tables, scopedQuery), QueryInputError);
});
test('investigation auto-authorizes member PRD read while preserving explicit scope', () => {
  const cfg = { version: 1, environments: { env: { ...environment, tier: 'prd', membersRead: false } } };
  const p = planQuery(cfg, { environmentId: 'env', queryId: 'investigate', parameters: ['检查连接'] }, 'demo', { profile: 'owner', senderId: 'ou_member' });
  assert.equal(p.approvalRequired, false); assert.equal(p.approvedBy, 'policy:read-only');
  assert.throws(() => validateToolQuery(environment, { ...query, namespaces: [] }));
  assert.equal(validateToolQuery(environment, { ...query, maxCalls: 999 }),true);
  assert.equal(validateToolQuery(environment, { ...query, maxCalls: undefined }),true);
  assert.throws(()=>validateToolQuery(environment,{...query,maxCalls:-1}));
});
test('tool loop rechecks authorization after model decision and closes tools', async () => {
  const cfg = { version: 1, environments: { env: structuredClone(environment) } };
  const plan = planQuery(cfg, { environmentId: 'env', queryId: 'investigate', parameters: ['检查配置'] }, 'demo', { profile: 'owner', senderId: 'ou_member' });
  const calls = []; let closed = false;
  const result = await investigateEnvironment(plan, async () => {}, { load: async () => cfg, credential: async () => credentials,
    tools: async () => ({ spec: [{ tool: 'connection' }, { tool: 'discover' }], run: async t => { calls.push(t); return {}; }, close: async () => { closed = true; } }),
    planner: async () => ({ next: async () => { cfg.environments.env.membersRead = false; return { tool: 'discover', arguments: '{}' }; }, close: async () => {} }) });
  assert.equal(result.partial,true);
  assert.deepEqual(calls, ['connection']); assert.equal(closed, true);
});
test('tool loop reports unresolved extraction as partial even when model claims complete', async () => {
  const cfg = { version: 1, environments: { env: environment } }, plan = planQuery(cfg, { environmentId: 'env', queryId: 'investigate', parameters: ['查数据库'] }, 'demo', { profile: 'owner', senderId: 'ou_member' });
  let n = 0;
  const r = await investigateEnvironment(plan, async () => {}, { load: async () => cfg, credential: async () => credentials,
    tools: async () => ({ spec: [{ tool: 'connection' },{ tool: 'read_config' }], run: async t => t === 'connection' ? {} : { rows: [], partial: true }, close: async () => {} }),
    planner: async () => ({ next: async () => ++n === 1 ? { tool: 'read_config', arguments: '{}' } : { tool: 'finish', summary: 'done', complete: true }, close: async () => {} }) });
  assert.equal(r.partial, true); assert.equal(r.evidence.toolCount, 2);
});

test('oversized website snapshots are compacted and remain usable instead of failing the job', () => {
  const controls = Array.from({ length: 150 }, (_, i) => ({
    ref: `ref-${i}-${'x'.repeat(80)}`, type: 'read-action', label: `查看详情 ${i} ${'字段'.repeat(30)}`,
    options: Array.from({ length: 20 }, (__, n) => ({ value: `${n}`, label: `选项 ${n}` })),
  }));
  const fitted = fitToolResult({ stage: '已读取业务网页', pageText: '页面内容'.repeat(5000), controls, rows: [], note: '只读页面' });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 24000);
  assert.equal(fitted.resultLimited, true);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.controls.length > 0);
  assert.match(fitted.note, /自动压缩/);
});
test('MySQL dynamic tools verify grants, use only base table metadata, bind values and rollback', async () => {
  const calls = []; let connectionOptions; const c = { query: async sql => { calls.push(sql); return [[{ grant: 'GRANT SELECT ON demo.* TO reader' }]]; }, execute: async (statement, params) => {
    calls.push({ sql: statement.sql, params });
    return statement.sql.includes('information_schema') ? [[{ table_name:'orders',column_name:'id' },{table_name:'orders',column_name:'status'},{table_name:'orders',column_name:'password'}]] : [[{ status:'ok',password:'never-return' }]];
  }, rollback:async()=>calls.push('rollback'), destroy:()=>calls.push('destroy') };
  const tools=await createEnvironmentTools({...environment,kind:'mysql',host:'localhost',port:3306,database:'demo'},query,credentials,{mysql:{createConnection:async options=>{connectionOptions=options;return c;}}});
  await tools.run('connection');const schema=await tools.run('schema');assert.deepEqual(schema.tables.orders,['id','status']);
  assert.equal(connectionOptions.supportBigNumbers,true);assert.equal(connectionOptions.bigNumberStrings,true);
  const r=await tools.run('select',{table:'orders',columns:['status'],filters:[{column:'id',op:'=',value:"' OR 1=1"}]});
  assert.deepEqual(r.rows,[{status:'ok'}]);assert.ok(calls.includes('START TRANSACTION READ ONLY'));
  const metadata=calls.find(x=>x.sql?.includes('information_schema'));assert.match(metadata.sql,/BASE TABLE/);assert.match(metadata.sql,/GENERATED/);
  const select=calls.find(x=>x.sql?.startsWith('SELECT `status`'));assert.deepEqual(select.params,["' OR 1=1"]);assert.doesNotMatch(select.sql,/OR 1=1/);
  await tools.close();assert.equal(calls.at(-1),'destroy');
});
test('MySQL JSON fields remain readable while nested secrets are removed',async()=>{
 const payload={items:[{expenseName:'临促费',unitPrice:130,formula:'130/4'}],password:'must-not-leak',nested:{token:'also-hidden',amount:32.5}};
 const driver={createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async statement=>statement.sql.includes('information_schema')
  ?[[{table_name:'orders',column_name:'id'},{table_name:'orders',column_name:'fee_json'}]]
  :[[{fee_json:payload}]],rollback:async()=>{},destroy:()=>{}})};
 const tools=await createEnvironmentTools({...environment,kind:'mysql',host:'fake',database:'demo'},query,credentials,{mysql:driver});
 try{
  await tools.run('schema',{table:'orders'});
  const result=await tools.run('select',{table:'orders',columns:['fee_json'],filters:[{column:'id',op:'=',value:'one'}]});
  const value=result.rows[0].fee_json;
  assert.match(value,/临促费/);assert.match(value,/unitPrice/);assert.match(value,/130/);assert.match(value,/32\.5/);
  assert.doesNotMatch(value,/\[object Object\]|must-not-leak|also-hidden|password|token/);assert.ok(value.length<=500);
 }finally{await tools.close();}
});
test('schema can discover exact fields in a wide table without paging through unrelated columns', async () => {
  const calls=[];
  const driver={createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async(statement,params)=>{
    calls.push({sql:statement.sql,params});
    return [[{table_name:'sys_operation_log_202609',column_name:'oper_time'},{table_name:'sys_operation_log_202609',column_name:'oper_param'}]];
  },rollback:async()=>{},destroy:()=>{}})};
  const tools=await createEnvironmentTools({...environment,kind:'mysql',host:'fake',database:'demo'}, {...query,tables:['*']}, credentials,{mysql:driver});
  try {
    const result=await tools.run('schema',{table:'sys_operation_log_202609',columns:['oper_time','oper_param']});
    assert.deepEqual(result.tables.sys_operation_log_202609,['oper_time','oper_param']);
    assert.equal(result.truncated,false);assert.equal(result.nextCursor,null);
    assert.match(calls.at(-1).sql,/c\.COLUMN_NAME IN \(\?, \?\)/);
    assert.deepEqual(calls.at(-1).params,['demo','sys_operation_log_202609','oper_time','oper_param']);
    await assert.rejects(tools.run('schema',{columns:['oper_time']}),QueryInputError);
  } finally { await tools.close(); }
});
test('MySQL tools never query business data using a write-capable account', async()=>{
  let business=0;const c={query:async()=>[[{grant:'GRANT ALL PRIVILEGES ON demo.* TO reader'}]],execute:async()=>{business++;return[[]];},destroy:()=>{}};
  const t=await createEnvironmentTools({...environment,kind:'mysql'},query,credentials,{mysql:{createConnection:async()=>c}});
  await assert.rejects(t.run('connection'));assert.equal(business,0);await t.close();
});
test('tool operation limit and late connections stop further activity', async()=>{
  let destroyed=0;const c={query:async()=>{throw new Error('must not run after timeout');},destroy:()=>destroyed++};
  const t=await createEnvironmentTools({...environment,kind:'mysql'}, {...query,timeoutMs:10,maxCalls:1},credentials,{mysql:{createConnection:async()=>{await new Promise(r=>setTimeout(r,30));return c;}}});
  await assert.rejects(t.run('connection'));await new Promise(r=>setTimeout(r,40));assert.equal(destroyed,1);await assert.rejects(t.run('schema'));await t.close();
});

test('large schemas stay within tool budget and can continue by cursor or target table',async()=>{
 const metadata=Array.from({length:240},(_,i)=>({table_name:'table_'+String(i).padStart(3,'0')+'x'.repeat(45),column_name:'column_'+'y'.repeat(50)}));const calls=[];
 const driver={createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO user'}]],execute:async statement=>{calls.push(statement.sql);const offset=Number(/OFFSET (\d+)/.exec(statement.sql)?.[1]??0);return [metadata.slice(offset,offset+101)];},rollback:async()=>{},destroy:()=>{}})};
 const tools=await createEnvironmentTools({kind:'mysql',host:'fake',database:'demo'}, {...query,tables:['*'],maxCalls:6},credentials,{mysql:driver});
 try {await tools.run('connection');const a=await tools.run('schema');assert.equal(a.nextCursor,100);assert.ok(Buffer.byteLength(JSON.stringify(a))<24000);assert.equal(Object.keys(a.tables).length,100);
 const b=await tools.run('schema',{cursor:a.nextCursor});assert.equal(b.nextCursor,200);const c=await tools.run('schema',{cursor:b.nextCursor});assert.equal(c.truncated,false);assert.equal(Object.keys(c.tables).length,40);
 await assert.rejects(tools.run('schema',{table:'bad;DELETE'}));assert.match(calls[1],/OFFSET 100/);
 }finally{await tools.close();}
});

test('SELECT input failures are specific and hard scope failures remain nonrecoverable', () => {
 const tables=new Map([['orders',Array.from({length:13},(_,i)=>'field'+i)]]);
 const args={table:'orders',columns:tables.get('orders'),filters:[{column:'field0',op:'=',value:'test'}]};
 assert.throws(()=>selectStatement(args,tables,query),e=>e instanceof QueryInputError&&e.code==='COLUMN_LIMIT');
 assert.throws(()=>selectStatement({...args,columns:['missing']},tables,query),e=>e.code==='SCHEMA_FIELDS');
 assert.throws(()=>selectStatement({...args,columns:['field0']},new Map(),query),e=>e.code==='SCHEMA_REQUIRED');
 for(const change of [{table:'other'},{columns:['password']},{filters:[{column:'token',op:'=',value:'x'}],columns:['field0']}])
  assert.throws(()=>selectStatement({...args,...change},tables,query),e=>!(e instanceof QueryInputError));
});
test('planner corrects too many fields without executing invalid SQL or widening authorization', async()=>{
 const q={...query,maxCalls:8},env={...environment,kind:'mysql',host:'fake',port:3306,database:'demo',queries:{investigate:q}};
 const cfg={version:1,environments:{env}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['查指定记录']},'demo',{profile:'owner',senderId:'ou_member'});
 const cols=Array.from({length:13},(_,i)=>'field'+i);let business=0,closed=false,n=0;
 const driver={createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async stmt=>{
 if(stmt.sql.includes('information_schema'))return[cols.map(column_name=>({table_name:'orders',column_name}))];
 business++;assert.match(stmt.sql,/WHERE `field0` = \? LIMIT/);return[[{field1:'found'}]];
 },rollback:async()=>{},destroy:()=>{closed=true;}})};
 const result=await investigateEnvironment(plan,async()=>{}, {load:async()=>cfg,credential:async()=>credentials,
 tools:async(e,q,c)=>createEnvironmentTools(e,q,c,{mysql:driver}),planner:async()=>({next:async input=>{
 n++;if(n===1)return{tool:'schema',arguments:'{"table":"orders"}'};
 if(n===2)return{tool:'select',arguments:JSON.stringify({table:'orders',columns:cols,filters:[{column:'field0',op:'=',value:'record'}]})};
 if(n===3){assert.equal(input.results.at(-1).error.code,'COLUMN_LIMIT');assert.equal(input.results.at(-1).executed,false);return{tool:'select',arguments:JSON.stringify({table:'orders',columns:['field1'],filters:[{column:'field0',op:'=',value:'record'}]})};}
 return{tool:'finish',summary:'已找到',complete:true};},close:async()=>{}})});
 assert.equal(business,1);assert.equal(closed,true);assert.equal(result.partial,false);assert.deepEqual(result.rows,[{field1:'found','来源表':'orders'}]);assert.equal(result.evidence.toolCount,4);
});
test('recoverable input attempts are bounded and unresolved finish cannot become success',async()=>{
 for(const finish of [false,true]){
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['查指定记录']},'demo',{profile:'owner',senderId:'ou_member'});let attempts=0,closed=false;
 const run=()=>investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{if(t==='connection')return{};attempts++;throw new QueryInputError('COLUMN_LIMIT','too many');},close:async()=>{closed=true;}}),
 planner:async()=>({next:async()=>finish&&attempts?{tool:'finish',complete:true,summary:'incorrect success'}:{tool:'select',arguments:'{}'},close:async()=>{}})});
 if(finish){const r=await run();assert.equal(r.partial,true);assert.doesNotMatch(r.summary,/incorrect success/);}else{const r=await run();assert.equal(r.partial,true);assert.match(r.summary,/COLUMN_LIMIT/);assert.equal(attempts,3);}assert.equal(closed,true);
 }
});
test('scope failures never enter parameter correction loop',async()=>{
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['查指定记录']},'demo',{profile:'owner',senderId:'ou_member'});let attempts=0;
 const result = await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{if(t==='connection')return{};attempts++;throw new Error('[SCOPE_LIMIT] denied');},close:async()=>{}}),
 planner:async()=>({next:async()=>({tool:'select',arguments:'{}'}),close:async()=>{}})});assert.equal(attempts,1);assert.equal(result.partial,true);assert.match(result.summary,/SCOPE_LIMIT/);
});

test('last tool result receives final synthesis with provenance and no extra query',async()=>{
 const q={...query,maxCalls:2},cfg={version:1,environments:{env:{...environment,queries:{investigate:q}}}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对指定记录']},'demo',{profile:'owner',senderId:'ou_member'});let executions=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{executions++;return t==='connection'?{}:{table:'orders',rows:[{id:'one'}]};},close:async()=>{}}),
 planner:async()=>({next:async input=>{if(input.remainingCalls===0){assert.deepEqual(input.tools,[]);assert.equal(input.results.at(-1).result.table,'orders');return{tool:'finish',summary:'已核对orders中指定记录；原因待查',complete:false};}return{tool:'select',arguments:'{}'};},close:async()=>{}})});
 assert.equal(executions,5);assert.equal(r.partial,true);assert.match(r.summary,/原因待查/);assert.deepEqual(r.rows,[{id:'one','来源表':'orders'}]);
});
test('final synthesis cannot execute tools and failures preserve prior evidence',async()=>{
 for(const fail of [false,true]){
 const q={...query,maxCalls:1},cfg={version:1,environments:{env:{...environment,queries:{investigate:q}}}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对']},'demo',{profile:'owner',senderId:'ou_member'});let calls=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,tools:async()=>({spec:[{tool:'connection'}],run:async()=>{calls++;return{stage:'connected'};},close:async()=>{}}),planner:async()=>({next:async input=>{if(input.remainingCalls!==0)return{tool:'connection',arguments:'{}'};if(fail)throw new Error('summary unavailable');return{tool:'select',arguments:'{}',complete:true};},close:async()=>{}})});
 assert.equal(calls,4);assert.equal(r.partial,true);assert.equal(r.steps.length,4);
 }
});

test('evidence-driven investigation passes twelve calls and legacy maxCalls without stopping',async()=>{
 const q={...query,maxCalls:1},cfg={version:1,environments:{env:{...environment,queries:{investigate:q}}}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对关联证据']},'demo',{profile:'owner',senderId:'ou_member'});let executed=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{executed++;return t==='connection'?{}:{table:'orders',rows:[{id:String(executed)}]};},close:async()=>{}}),
 planner:async()=>({next:async input=>{assert.equal(input.remainingCalls,undefined);return executed<16?{tool:'select',arguments:'{}'}:{tool:'finish',summary:'完成',complete:true};},close:async()=>{}})});
 assert.equal(executed,16);assert.equal(r.partial,false);assert.equal(r.rows.length,15);
});
test('expiry during long investigation retains evidence and prohibits subsequent queries',async()=>{
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对']},'demo',{profile:'owner',senderId:'ou_member'});let calls=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,tools:async()=>({spec:[{tool:'connection'}],run:async()=>{calls++;plan.expiresAt='2000-01-01T00:00:00Z';return{stage:'connected'};},close:async()=>{}}),planner:async()=>({next:async input=>{assert.deepEqual(input.tools,[]);return{tool:'finish',summary:'已有连接证据',complete:true};},close:async()=>{}})});
 assert.equal(calls,1);assert.equal(r.partial,true);assert.match(r.summary,/SCOPE_LIMIT/);assert.match(r.summary,/已有连接证据/);
 assert.ok(Number.isFinite(Date.parse(r.evidence.lastAuthorizedAt)));
});
test('MySQL tool layer no longer enforces legacy call count',async()=>{
 const c={query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],rollback:async()=>{},destroy:()=>{}};
 const t=await createEnvironmentTools({...environment,kind:'mysql'}, {...query,maxCalls:1}, credentials,{mysql:{createConnection:async()=>c}});
 try{for(let i=0;i<16;i++)await t.run('connection');}finally{await t.close();}
 await assert.rejects(t.run('connection'));
});

test('later browser timeout retains prior evidence and safe failure stage without retry', async()=>{
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['排查']},'demo',{profile:'owner',senderId:'ou_member'});
 let calls=0,closed=0;
 const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'browser_open'}],run:async tool=>{calls++;if(tool==='connection')return{stage:'connected',rows:[{host:'db.example',database:'demo'}]};throw Object.assign(new Error('timeout fake-secret secret-url'),{diagnosticStage:'browser.login-form'});},close:async()=>{closed++;}}),
 planner:async()=>({next:async input=>{if(input.tools.length)return{tool:'browser_open',arguments:'{}'};assert.equal(calls,2);assert.deepEqual(input.tools,[]);return{tool:'finish',complete:true,summary:'已有连接证据'};},close:async()=>{closed++;}})});
 assert.equal(result.partial,true);assert.equal(calls,2);assert.equal(closed,2);
 assert.equal(result.rows[0].host,'db.example');assert.match(result.summary,/等待登录表单/);assert.match(result.summary,/TIMEOUT/);assert.doesNotMatch(JSON.stringify(result),/fake-secret|secret-url/);
});

test('first tool timeout remains blocked and preserves safe operation metadata', async()=>{
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['排查']},'demo',{profile:'owner',senderId:'ou_member'});
 await assert.rejects(investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,tools:async()=>({spec:[{tool:'connection'}],run:async()=>{throw new Error('timeout');},close:async()=>{}}),planner:async()=>({next:async()=>{throw new Error('must not plan');},close:async()=>{}})}),e=>e.diagnosticStage==='connection');
});

for (const scenario of ['recover','repeat','persistent']) test(`mysql timeout recovery: ${scenario}`,async()=>{
 const env={...environment,kind:'mysql',host:'fake',port:3306,database:'demo',queries:{investigate:query}};
 const cfg={version:1,environments:{env}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['查指定记录']},'demo',{profile:'owner',senderId:'ou_member'});
 let attempts=0,opened=0,abortClosed=0,n=0;const progress=[];
 const r=await investigateEnvironment(plan,async e=>progress.push(e),{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>{opened++;return{spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{
 if(tool==='connection')return{stage:'connected'};
 attempts++;if(scenario==='recover'&&attempts===2)return{table:'orders',rows:[{id:'found'}]};throw new Error('环境工具超时');
 },close:async opts=>{if(opts?.abort)abortClosed++;}};},
 planner:async()=>({next:async input=>{
 if(input.remainingCalls===0)return{tool:'finish',complete:true,summary:'仅已有证据'};
 if(scenario==='recover'&&attempts===2)return{tool:'finish',complete:true,summary:'已取得缩小范围后的查询结果'};
 return{tool:'select',arguments:JSON.stringify({filter:scenario==='repeat'?1:++n})};
 },close:async()=>{}})});
 if(scenario==='recover'){assert.equal(r.partial,false);assert.equal(attempts,2);assert.equal(opened,2);assert.match(r.summary,/缩小范围/);}
 if(scenario==='repeat'){assert.equal(attempts,1);assert.equal(r.partial,true);assert.match(r.summary,/未调整已超时查询/);}
 if(scenario==='persistent'){assert.equal(attempts,3);assert.equal(r.partial,true);assert.match(r.summary,/连续3次业务查询超时/);}
 assert.ok(abortClosed>=1);assert.ok(progress.some(e=>e.activity?.current.includes('调整条件')));
});

test('aggregate counts validate same table fields and filters without sample limits or arbitrary SQL',async()=>{
 const {countStatement}=await import('../src/runner/environment-tools.js');const tables=new Map([['orders',['id','line','status']]]);
 const args={table:'orders',filters:[{column:'status',op:'=',value:'ready'}]};
 const all=countStatement(args,tables,query);assert.match(all.sql,/COUNT\(\*\)/);assert.doesNotMatch(all.sql,/LIMIT/);assert.deepEqual(all.params,['ready']);
 assert.match(countStatement({...args,distinctColumns:['id','line']},tables,query).sql,/COUNT\(DISTINCT `id`, `line`\)/);
 assert.throws(()=>countStatement({...args,table:'other'},tables,query));
 assert.throws(()=>countStatement({...args,distinctColumns:['id); DROP TABLE orders']},tables,query));
 assert.throws(()=>countStatement({...args,filters:[]},tables,query));
});

test('count tool returns database aggregate rather than returned-row length',async()=>{
 const queries=[];const driver={createConnection:async()=>({query:async()=>[[{grant:'GRANT SELECT ON demo.* TO reader'}]],execute:async stmt=>{queries.push(stmt.sql);return stmt.sql.includes('information_schema')?[[{table_name:'orders',column_name:'id'},{table_name:'orders',column_name:'status'}]]:[[{total:'28119'}]];},rollback:async()=>{},destroy:()=>{}})};
 const tools=await createEnvironmentTools({...environment,kind:'mysql',host:'fake',port:3306,database:'demo'},query,credentials,{mysql:driver});
 try{await tools.run('schema',{table:'orders'});const r=await tools.run('count',{table:'orders',filters:[{column:'status',op:'=',value:'ready'}]});assert.equal(r.rows[0].total,'28119');assert.equal(r.rows[0].countMode,'rows');assert.doesNotMatch(queries.at(-1),/LIMIT/);}finally{await tools.close();}
});
