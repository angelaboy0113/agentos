import test from 'node:test';
import assert from 'node:assert/strict';
import { transformDataset, verifyRelationalDataset } from '../src/shared/relational-dataset.js';

const source = rows => ({ rows, columns: ['customer', 'department', 'label', 'amount', 'status'], numericColumns: ['amount'], complete: true, readAt: '2026-11-06T05:11:00.000Z', snapshotId: 'original' });
const args = { datasetRef: 'raw', keyColumns: ['customer', 'department'], fields: [
  { column: 'label', as: 'labels', op: 'distinct_text', format: 'json', nulls: 'keep' },
  { column: 'amount', as: 'single_amount', op: 'assert_same', nulls: 'keep' },
], rowKey: 'key', evidence: '每个客户部门一行，金额为完整对象金额，明细标签全部保留' };

test('generic composite grouping retains every distinct label, null and exact header amount without multiplication', async () => {
  const raw = source([{ customer: '0001', department: 'D', label: 'a；b', amount: '9007199254740993.01' }, { customer: '0001', department: 'D', label: '长'.repeat(9000), amount: '9007199254740993.01' }, { customer: '0001', department: 'D', label: null, amount: '9007199254740993.01' }, { customer: '0001', department: 'D', label: 'a；b', amount: '9007199254740993.01' }]);
  const out = await transformDataset('summarize_dataset', args, async () => raw);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].single_amount, '9007199254740993.01');
  assert.deepEqual(new Set(JSON.parse(out.rows[0].labels)), new Set(['a；b', '长'.repeat(9000), null]));
  assert.deepEqual(out.numericColumns, ['single_amount']);
  assert.equal(out.readAt, raw.readAt);
  await verifyRelationalDataset(out, async () => raw);
  out.rows[0].labels = '[]';
  await assert.rejects(verifyRelationalDataset(out, async () => raw), /重放不一致/);
});

test('header conflicts cannot be disguised as one row, empty and cancelled sources remain explicit', async () => {
  const rows = [{ customer: 'A', department: 'D', label: 'first', amount: '10' }, { customer: 'A', department: 'D', label: 'second', amount: '20' }];
  await assert.rejects(transformDataset('summarize_dataset', args, async () => source(rows)), /整单字段存在冲突/);
  await assert.rejects(transformDataset('summarize_dataset', args, async () => source([{ ...rows[0], customer: null }])), /对象键为空/);
  const empty = await transformDataset('summarize_dataset', args, async () => source([]));
  assert.equal(empty.rows.length, 0);
  await assert.rejects(transformDataset('summarize_dataset', args, async () => source(rows), { check: async () => { throw Error('cancelled'); } }), /cancelled/);
});

test('source-backed enum mapping retains codes, audits unknowns and does not invent labels', async () => {
  const raw = source([{ customer: 'A', status: '3' }, { customer: 'B', status: 'new' }, { customer: 'C', status: null }]);
  const mapping = { datasetRef: 'raw', fields: [{ column: 'status', as: 'status_name', entries: [{ from: '3', to: '审批中' }], nulls: 'keep', unknown: 'keep', evidence: '项目源码状态字典' }] };
  const out = await transformDataset('map_values_dataset', mapping, async () => raw);
  assert.deepEqual(out.rows.map(row => row.status_name), ['审批中', 'new', null]);
  assert.equal(out.rows[0].status, '3');
  assert.equal(out.derivation.audit.fields[0].unknownRows, 1);
  assert.equal(out.derivation.audit.fields[0].nullRows, 1);
  await verifyRelationalDataset(out, async () => raw);
  await assert.rejects(transformDataset('map_values_dataset', { ...mapping, fields: [{ ...mapping.fields[0], unknown: 'error' }] }, async () => raw), /未登记/);
  await assert.rejects(transformDataset('map_values_dataset', { ...mapping, fields: [{ ...mapping.fields[0], as: 'status' }] }, async () => raw), /覆盖/);
});

test('new report transforms persist, refresh and retain the old version independently', async t => {
  const { ReportDatasets } = await import('../src/runner/report-datasets.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp('/private/tmp/text-report-refresh-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const datasets = new ReportDatasets({ directory: dir, scope: 'test', maxRows: 'all' });
  const collect = async (table, rows) => datasets.collect({ sql: 'SELECT id,label,status FROM ' + table, params: [], columns: ['id', 'label', 'status'], recipe: { tool: 'row_dataset', args: { table, columns: ['id', 'label', 'status'], orderBy: ['id'], filters: [] } } }, async () => [rows]);
  const pop = await collect('objects', [{ id: '001', label: '', status: '3' }]);
  const raw = await collect('facts', [{ id: '001', label: 'old', status: '3' }, { id: '001', label: 'other', status: '3' }]);
  const grouped = await datasets.transform('summarize_dataset', { datasetRef: raw.datasetRef, keyColumns: ['id'], fields: [{ column: 'label', as: 'labels', op: 'distinct_text', format: 'joined', separator: '；', nulls: 'exclude' }, { column: 'status', as: 'code', op: 'assert_same', nulls: 'keep' }], evidence: '全部标签按对象合并，状态须一致' });
  const mapped = await datasets.transform('map_values_dataset', { datasetRef: grouped.datasetRef, fields: [{ column: 'code', as: 'status_name', entries: [{ from: '3', to: '审批中' }], unknown: 'keep', nulls: 'keep', evidence: '测试项目已核实的字典' }] });
  const columns = [{ label: '编号', value: { op: 'key' } }, { label: '标签', value: { op: 'field', source: 's1', column: 'labels' } }, { label: '状态', value: { op: 'field', source: 's1', column: 'status_name' } }];
  const draft = await datasets.compose({ sources: [{ name: 's1', datasetRef: mapped.datasetRef, keyColumn: 'id' }], columns });
  const finalArgs = { datasetRef: draft.datasetRef, populationRef: pop.datasetRef, populationKey: 'id', expectedColumns: columns.map(c => c.label), requirement: '完整对象及所有标签状态', scopeEvidence: '独立完整对象来源及全部明细', columnRules: columns.map(c => ({ label: c.label, definition: c.label + '逐对象完整值', evidence: '测试来源实际字段与字典' })), checks: [] };
  await datasets.finalize(finalArgs);
  datasets.clear();
  const restored = await datasets.restore(mapped.datasetRef);
  await datasets.verifyDerived(restored);
  const refreshed = await datasets.refresh(finalArgs, { begin: async () => {}, reload: recipe => collect(recipe.args.table, [{ id: '001', label: 'new', status: '3' }]) });
  assert.equal((await datasets.restore(refreshed.refreshedDatasetRef)).rows[0]['标签'], 'new');
  assert.equal((await datasets.restore(mapped.datasetRef)).rows[0].labels, 'old；other');
});

test('complete exports can outlive the old overall timer while each page keeps its SQL deadline and authorization', async t => {
  const { createEnvironmentTools } = await import('../src/runner/environment-tools.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp('/private/tmp/paged-text-report-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  let authorizations = 0, pages = 0;
  const rows = Array.from({ length: 1001 }, (_, index) => ({ id: String(index), amount: '1' }));
  const mysql = { createConnection: async () => ({ query: async sql => sql.startsWith('SHOW GRANTS') ? [[{ grant: 'GRANT SELECT ON demo.* TO reader' }]] : [[]], execute: async statement => {
    if (statement.sql.includes('information_schema')) return [[{ table_name: 'facts', column_name: 'id', data_type: 'varchar', engine: 'InnoDB' }, { table_name: 'facts', column_name: 'amount', data_type: 'decimal', engine: 'InnoDB' }]];
    assert.equal(statement.timeout, 1000);
    await new Promise(resolve => setTimeout(resolve, 12));
    pages++;
    const match = statement.sql.match(/LIMIT (\d+) OFFSET (\d+)$/);
    return [rows.slice(Number(match[2]), Number(match[2]) + Number(match[1]))];
  }, rollback: async () => {}, destroy: () => {} }) };
  const tools = await createEnvironmentTools({ kind: 'mysql', host: 'db', port: 3306, database: 'demo' }, { tables: ['facts'], maxRows: 5, timeoutMs: 1000, exportMaxRows: 'all', exportTimeoutMs: 1 }, {}, { mysql, exportDirectory: dir, authorize: async () => { authorizations++; } });
  t.after(() => tools.close());
  await tools.run('schema', { table: 'facts' });
  const result = await tools.run('group_dataset', { table: 'facts', groupColumns: ['id'], aggregates: [{ op: 'sum', column: 'amount', as: 'amount' }], filters: [] });
  assert.equal(result.rowCount, 1001);
  assert.equal(result.complete, true);
  assert.equal(pages, 3);
  assert.ok(authorizations > pages);
});

test('large local membership filters preserve exact text IDs and decimal comparison semantics', async () => {
  const raw = source([{ customer: '0001', department: 'A', amount: '1.00' }, { customer: '1', department: 'A', amount: '1' }]);
  const values = Array.from({ length: 20000 }, (_, index) => 'code-' + index).concat('0001');
  const out = await transformDataset('filter_dataset', { datasetRef: 'raw', match: 'all', filters: [{ column: 'customer', op: 'in', type: 'text', value: values }] }, async () => raw);
  assert.deepEqual(out.rows.map(row => row.customer), ['0001']);
  const decimal = await transformDataset('filter_dataset', { datasetRef: 'raw', match: 'all', filters: [{ column: 'amount', op: 'in', type: 'decimal', value: ['1.0'] }] }, async () => raw);
  assert.equal(decimal.rows.length, 2);
});

test('large local evidence recipes remain certifiable and file-bound inspection returns an explicit preview', async t => {
  const { ReportDatasets } = await import('../src/runner/report-datasets.js');
  const { inspectReport } = await import('../src/shared/report-inspection.js');
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const root = await mkdtemp('/private/tmp/large-text-proof-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = root + '/exports/JOB-proof', datasets = new ReportDatasets({ directory: dir, scope: 'test', maxRows: 'all' });
  const raw = await datasets.collect({ sql: 'SELECT id,status FROM objects', columns: ['id', 'status'], params: [] }, async () => [[{ id: '001', status: '3' }]]);
  const entries = Array.from({ length: 5000 }, (_, index) => ({ from: String(index), to: '字典状态名称' + index }));
  const mapped = await datasets.transform('map_values_dataset', { datasetRef: raw.datasetRef, fields: [{ column: 'status', as: 'label', entries, nulls: 'keep', unknown: 'keep', evidence: '真实项目完整字典的测试替身' }] });
  const draft = await datasets.compose({ sources: [{ name: 's1', datasetRef: mapped.datasetRef, keyColumn: 'id' }], columns: [{ label: '编号', value: { op: 'key' } }, { label: '状态', value: { op: 'field', source: 's1', column: 'label' } }] });
  const final = await datasets.finalize({ datasetRef: draft.datasetRef, populationRef: raw.datasetRef, populationKey: 'id', expectedColumns: ['编号', '状态'], requirement: '导出完整对象状态', scopeEvidence: '独立原始对象全集', columnRules: ['编号', '状态'].map(label => ({ label, definition: label + '实际字段', evidence: '完整字典与原始字段' })), checks: [] });
  assert.ok((await stat(dir + '/' + final.exportFile.id + '.verification.json')).size > 64000);
  const inspection = await inspectReport(root, { id: 'JOB-proof', reportFiles: [final.exportFile] }, { fileId: final.exportFile.id });
  assert.equal(inspection.status, 'verified');
  assert.equal(inspection.sources[0].derivation.limited, true);
  assert.equal((await datasets.restore(mapped.datasetRef)).derivation.args.fields[0].entries.length, 5000);
});
