import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Codex result schema uses the supported strict subset', async () => {
  const schema = JSON.parse(await readFile(new URL('../config/task-result.schema.json', import.meta.url), 'utf8'));
  const unsupported = [];
  const missingRequired = [];
  const visit = (value, path = '$') => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'uniqueItems')) unsupported.push(`${path}.uniqueItems`);
    if (value.properties && Array.isArray(value.required)) {
      for (const key of Object.keys(value.properties)) if (!value.required.includes(key)) missingRequired.push(`${path}.properties.${key}`);
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else Object.entries(value).forEach(([key, child]) => visit(child, `${path}.${key}`));
  };
  visit(schema);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(missingRequired, []);
});
