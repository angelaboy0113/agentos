import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseEndpoints } from '../src/runner/config-endpoints.js';
import { createEnvironmentTools, selectStatement } from '../src/runner/environment-tools.js';
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
