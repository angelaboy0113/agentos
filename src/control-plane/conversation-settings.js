import { readFile } from 'node:fs/promises';
export async function loadConversationSettings(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { groupSessions: false, questionCards: false }; throw error; }
  if (typeof value.groupSessions !== 'boolean' || typeof value.questionCards !== 'boolean') throw new Error('Invalid conversation configuration');
  return { groupSessions: value.groupSessions, questionCards: value.questionCards };
}
