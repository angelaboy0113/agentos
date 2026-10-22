import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Deployment configuration, never model output, selects the system scope.
export function resolveProjectId(projects, chatId, profile) {
  if (Object.hasOwn(projects.chatProfileProjectMap ?? {}, chatId)) {
    const scopes = projects.chatProfileProjectMap[chatId];
    return Object.hasOwn(scopes, profile) ? scopes[profile] : null;
  }
  return Object.hasOwn(projects.chatProjectMap ?? {}, chatId) ? projects.chatProjectMap[chatId] : null;
}

export function routeAgent(agents, role, profile) {
  const scoped = Object.values(agents ?? {}).find(agent => agent.systemAssistant === true && agent.profile === profile);
  const agent = scoped ?? agents?.[role === 'owner_report' ? 'owner_intake' : role];
  return { agentRole: role, agentProfile: agent?.profile ?? null };
}

export async function assistantInstructions(project) {
  if (!project?.assistantInstructionsFile) return '';
  const text = await readFile(path.resolve(project.assistantInstructionsFile), 'utf8');
  if (!text.trim()) throw new Error('系统助手规范为空，请管理员检查配置');
  return text;
}

export function validateProjectScopes(parsed) {
  const map = parsed.chatProfileProjectMap ?? {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Invalid chatProfileProjectMap');
  for (const scopes of Object.values(map)) {
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes) || !Object.keys(scopes).length) throw new Error('Invalid profile project scope');
    for (const [profile, projectId] of Object.entries(scopes)) {
      if (!profile.trim() || typeof projectId !== 'string' || !Object.hasOwn(parsed.projects ?? {}, projectId)) throw new Error('Unknown profile project scope');
    }
  }
  return map;
}
