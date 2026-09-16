import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseEndpoints } from '../src/runner/config-endpoints.js';
import { createEnvironmentTools, selectStatement, QueryInputError } from '../src/runner/environment-tools.js';
import { validateToolQuery } from '../src/shared/environment-tool-policy.js';
import { planQuery } from '../src/shared/environment-access.js';
import { investigateEnvironment } from '../src/runner/environment-investigator.js';
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
test('investigation preserves member PRD approval gate and needs explicit scope', () => {
  const cfg = { version: 1, environments: { env: { ...environment, tier: 'prd', membersRead: false } } };
  const p = planQuery(cfg, { environmentId: 'env', queryId: 'investigate', parameters: ['检查连接'] }, 'demo', { profile: 'owner', senderId: 'ou_member' });
  assert.equal(p.approvalRequired, true); assert.equal(p.approvedBy, null);
  assert.throws(() => validateToolQuery(environment, { ...query, namespaces: [] }));
  assert.throws(() => validateToolQuery(environment, { ...query, maxCalls: 999 }));
});
test('tool loop rechecks authorization after model decision and closes tools', async () => {
  const cfg = { version: 1, environments: { env: structuredClone(environment) } };
  const plan = planQuery(cfg, { environmentId: 'env', queryId: 'investigate', parameters: ['检查配置'] }, 'demo', { profile: 'owner', senderId: 'ou_member' });
  const calls = []; let closed = false;
  await assert.rejects(investigateEnvironment(plan, async () => {}, { load: async () => cfg, credential: async () => credentials,
    tools: async () => ({ spec: [{ tool: 'connection' }, { tool: 'discover' }], run: async t => { calls.push(t); return {}; }, close: async () => { closed = true; } }),
    planner: async () => ({ next: async () => { cfg.environments.env.membersRead = false; return { tool: 'discover', arguments: '{}' }; }, close: async () => {} }) }));
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
test('MySQL dynamic tools verify grants, use only base table metadata, bind values and rollback', async () => {
  const calls = []; const c = { query: async sql => { calls.push(sql); return [[{ grant: 'GRANT SELECT ON demo.* TO reader' }]]; }, execute: async (statement, params) => {
    calls.push({ sql: statement.sql, params });
    return statement.sql.includes('information_schema') ? [[{ table_name:'orders',column_name:'id' },{table_name:'orders',column_name:'status'},{table_name:'orders',column_name:'password'}]] : [[{ status:'ok',password:'never-return' }]];
  }, rollback:async()=>calls.push('rollback'), destroy:()=>calls.push('destroy') };
  const tools=await createEnvironmentTools({...environment,kind:'mysql',host:'localhost',port:3306,database:'demo'},query,credentials,{mysql:{createConnection:async()=>c}});
  await tools.run('connection');const schema=await tools.run('schema');assert.deepEqual(schema.tables.orders,['id','status']);
  const r=await tools.run('select',{table:'orders',columns:['status'],filters:[{column:'id',op:'=',value:"' OR 1=1"}]});
  assert.deepEqual(r.rows,[{status:'ok'}]);assert.ok(calls.includes('START TRANSACTION READ ONLY'));
  const metadata=calls.find(x=>x.sql?.includes('information_schema'));assert.match(metadata.sql,/BASE TABLE/);assert.match(metadata.sql,/GENERATED/);
  const select=calls.find(x=>x.sql?.startsWith('SELECT `status`'));assert.deepEqual(select.params,["' OR 1=1"]);assert.doesNotMatch(select.sql,/OR 1=1/);
  await tools.close();assert.equal(calls.at(-1),'destroy');
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
 if(finish){const r=await run();assert.equal(r.partial,true);assert.doesNotMatch(r.summary,/incorrect success/);}else{await assert.rejects(run(),e=>e.code==='COLUMN_LIMIT');assert.equal(attempts,3);}assert.equal(closed,true);
 }
});
test('scope failures never enter parameter correction loop',async()=>{
 const cfg={version:1,environments:{env:environment}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['查指定记录']},'demo',{profile:'owner',senderId:'ou_member'});let attempts=0;
 await assert.rejects(investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{if(t==='connection')return{};attempts++;throw new Error('[SCOPE_LIMIT] denied');},close:async()=>{}}),
 planner:async()=>({next:async()=>({tool:'select',arguments:'{}'}),close:async()=>{}})}));assert.equal(attempts,1);
});

test('last tool result receives final synthesis with provenance and no extra query',async()=>{
 const q={...query,maxCalls:2},cfg={version:1,environments:{env:{...environment,queries:{investigate:q}}}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对指定记录']},'demo',{profile:'owner',senderId:'ou_member'});let executions=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async t=>{executions++;return t==='connection'?{}:{table:'orders',rows:[{id:'one'}]};},close:async()=>{}}),
 planner:async()=>({next:async input=>{if(input.remainingCalls===0){assert.deepEqual(input.tools,[]);assert.equal(input.results.at(-1).result.table,'orders');return{tool:'finish',summary:'已核对orders中指定记录；原因待查',complete:false};}return{tool:'select',arguments:'{}'};},close:async()=>{}})});
 assert.equal(executions,2);assert.equal(r.partial,true);assert.match(r.summary,/原因待查/);assert.deepEqual(r.rows,[{id:'one','来源表':'orders'}]);
});
test('final synthesis cannot execute tools and failures preserve prior evidence',async()=>{
 for(const fail of [false,true]){
 const q={...query,maxCalls:1},cfg={version:1,environments:{env:{...environment,queries:{investigate:q}}}},plan=planQuery(cfg,{environmentId:'env',queryId:'investigate',parameters:['核对']},'demo',{profile:'owner',senderId:'ou_member'});let calls=0;
 const r=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,credential:async()=>credentials,tools:async()=>({spec:[{tool:'connection'}],run:async()=>{calls++;return{stage:'connected'};},close:async()=>{}}),planner:async()=>({next:async()=>{if(fail)throw new Error('summary unavailable');return{tool:'select',arguments:'{}',complete:true};},close:async()=>{}})});
 assert.equal(calls,1);assert.equal(r.partial,true);assert.equal(r.steps.length,1);
 }
});
