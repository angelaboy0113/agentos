import { createHash } from 'node:crypto';

// Display summaries never replace the full immutable recipe kept on disk.
export function provenancePreview(derivation) {
  if (!derivation || Buffer.byteLength(JSON.stringify(derivation)) <= 8000) return derivation;
  const summarize = value => {
    if (Array.isArray(value)) {
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > 4000) return {
        count: value.length,
        sha256: createHash('sha256').update(serialized).digest('hex'),
        preview: value.slice(0, 4).map(summarize),
        limited: true,
      };
      return value.map(summarize);
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarize(item)]));
    return value;
  };
  return { ...summarize(derivation), limited: true, note: '长列表仅显示数量、摘要及少量预览，预览不是完整筛选或映射范围；完整配方保存在绑定数据集和核验记录中。' };
}
