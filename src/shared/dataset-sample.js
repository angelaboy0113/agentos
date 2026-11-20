import { createHmac } from 'node:crypto';

const reject = message => { throw Object.assign(new Error(message), { code: 'REPORT_INPUT' }); };

// A fresh host-generated seed ranks stable keys independently of row order.
export function sampleDataset({ datasetRef, keyColumn, size, seed }, source) {
  if (!source?.complete || source.reportDraft || !source.columns.includes(keyColumn)) {
    reject('随机抽样需要本任务完整来源及真实唯一键，不能从预览抽样');
  }
  if (!Number.isSafeInteger(size) || size < 1 || !/^[0-9a-f]{64}$/.test(seed ?? '')) {
    reject('需指定正整数样本数及有效抽样种子');
  }
  const seen = new Set();
  const ranked = source.rows.map(row => {
    const key = row[keyColumn];
    if (typeof key !== 'string' || !key || seen.has(key)) reject('抽样主键必须非空且唯一');
    seen.add(key);
    return { key, row, rank: createHmac('sha256', Buffer.from(seed, 'hex')).update(key).digest('hex') };
  });
  ranked.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : 1);
  const rows = ranked.slice(0, size).map(item => item.row);
  return {
    rows, columns: source.columns, numericColumns: source.numericColumns ?? [], complete: true,
    readAt: source.readAt, readThroughAt: source.readThroughAt ?? source.readAt, snapshotId: source.snapshotId,
    derivation: {
      kind: 'random_sample', version: 1, args: { datasetRef, keyColumn, size, seed },
      audit: { populationRows: ranked.length, sampledRows: rows.length, requestedRows: size, withoutReplacement: true }
    }
  };
}
