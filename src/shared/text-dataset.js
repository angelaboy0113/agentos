import { createHash } from 'node:crypto';

const inputError = message => { throw Object.assign(new Error(message), { code: 'REPORT_INPUT' }); };
const validName = name => typeof name === 'string' && name.trim() && !['__proto__', 'constructor', 'prototype'].includes(name);
const validateColumn = (data, column) => { if (!data.columns.includes(column)) inputError('文本转换字段不在完整来源中'); };
const outputNames = (names, existing = []) => {
  if (names.some(name => !validName(name) || existing.includes(name)) || new Set(names).size !== names.length) inputError('输出字段须唯一，且不能覆盖已有字段');
};

export async function transformTextDataset(tool, args, data, check) {
  if (tool === 'map_values_dataset') return mapValues(args, data, check);
  if (tool === 'summarize_dataset') return summarize(args, data, check);
  return null;
}

async function mapValues(args, data, check) {
  if (!Array.isArray(args.fields) || !args.fields.length) inputError('映射需fields数组');
  outputNames(args.fields.map(field => field?.as), data.columns);
  const fields = args.fields.map(field => {
    validateColumn(data, field.column);
    if (!['keep', 'empty', 'error'].includes(field.unknown) || !['keep', 'error'].includes(field.nulls) ||
        typeof field.evidence !== 'string' || !field.evidence.trim() || !Array.isArray(field.entries)) inputError('映射需entries、unknown=keep/empty/error、nulls=keep/error及业务依据');
    const values = new Map();
    for (const entry of field.entries) {
      if (typeof entry?.from !== 'string' || typeof entry.to !== 'string' || values.has(entry.from)) inputError('映射原值和标签须为字符串，原值不能重复');
      values.set(entry.from, entry.to);
    }
    return { ...field, values, unknownRows: 0, nullRows: 0 };
  });
  const rows = [];
  for (const row of data.rows) {
    await check();
    const output = { ...row };
    for (const field of fields) {
      const value = row[field.column];
      if (value === null || value === '') {
        field.nullRows++;
        if (field.nulls === 'error') inputError('映射来源为空，请明确空值处理');
        output[field.as] = value;
      } else if (field.values.has(value)) output[field.as] = field.values.get(value);
      else {
        field.unknownRows++;
        if (field.unknown === 'error') inputError('发现未登记的映射原值，请核对源码字典并补充，不能猜测标签');
        output[field.as] = field.unknown === 'empty' ? null : value;
      }
    }
    rows.push(output);
  }
  return { rows, columns: [...data.columns, ...fields.map(field => field.as)], numericColumns: data.numericColumns ?? [],
    audit: { inputRows: data.rows.length, outputRows: rows.length, fields: fields.map(field => ({ column: field.column, as: field.as, unknownRows: field.unknownRows, nullRows: field.nullRows })) } };
}

async function summarize(args, data, check) {
  if (!Array.isArray(args.keyColumns) || !args.keyColumns.length || new Set(args.keyColumns).size !== args.keyColumns.length ||
      !Array.isArray(args.fields) || !args.fields.length || typeof args.evidence !== 'string' || !args.evidence.trim()) inputError('汇总需实际keyColumns、fields及业务粒度依据');
  outputNames(args.keyColumns);
  args.keyColumns.forEach(column => validateColumn(data, column));
  outputNames(args.fields.map(field => field?.as), args.keyColumns);
  if (args.rowKey) outputNames([...args.keyColumns, ...args.fields.map(field => field.as), args.rowKey]);
  for (const field of args.fields) {
    validateColumn(data, field.column);
    if (!['distinct_text', 'assert_same'].includes(field.op) || !['keep', 'exclude', 'error'].includes(field.nulls)) inputError('字段支持distinct_text或assert_same，需明确nulls=keep/exclude/error');
    if (field.op === 'distinct_text' && (!['json', 'joined'].includes(field.format) ||
        field.format === 'joined' && (typeof field.separator !== 'string' || !field.separator))) inputError('文本集合需format=json/joined，joined需明确分隔符');
  }
  const groups = new Map();
  let emptyCells = 0;
  for (const row of data.rows) {
    await check();
    const values = args.keyColumns.map(column => row[column]);
    if (values.some(value => value === null || value === undefined || value === '')) inputError('汇总对象键为空，不能合并未知对象');
    const key = JSON.stringify(values);
    if (!groups.has(key)) groups.set(key, { values, cells: args.fields.map(() => new Map()) });
    const group = groups.get(key);
    args.fields.forEach((field, index) => {
      const value = row[field.column];
      if (value === null || value === '') {
        emptyCells++;
        if (field.nulls === 'error') inputError('汇总来源有空值，请明确处理');
        if (field.nulls === 'exclude') return;
      }
      if (value !== null && typeof value !== 'string') inputError('文本汇总或一致性核验仅接受原始精确字符串及null');
      group.cells[index].set(JSON.stringify(value), value);
    });
  }
  const rows = [];
  let multiValueCells = 0;
  for (const [key, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    await check();
    const row = Object.fromEntries(args.keyColumns.map((column, index) => [column, group.values[index]]));
    args.fields.forEach((field, index) => {
      const values = [...group.cells[index].values()].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      if (values.length > 1) multiValueCells++;
      if (field.op === 'assert_same') {
        if (values.length > 1) inputError('同一对象的整单字段存在冲突，不能任意取一条或把重复整单金额求和');
        row[field.as] = values[0] ?? null;
      } else row[field.as] = field.format === 'json' ? JSON.stringify(values) : values.filter(value => value !== null).join(field.separator);
    });
    if (args.rowKey) row[args.rowKey] = createHash('sha256').update(key).digest('hex');
    rows.push(row);
  }
  return { rows, columns: [...args.keyColumns, ...args.fields.map(field => field.as), ...(args.rowKey ? [args.rowKey] : [])],
    numericColumns: args.fields.filter(field => field.op === 'assert_same' && data.numericColumns?.includes(field.column)).map(field => field.as),
    audit: { inputRows: data.rows.length, outputRows: rows.length, emptyCells, multiValueCells, evidence: args.evidence } };
}
