// Trusted local configuration only. Display names and callback-provided identity claims are never authority.
export function validateHumanIdentities(identities = {}) {
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) throw new Error('humanIdentities must be an object');
  const seen = new Set();
  for (const mapping of Object.values(identities)) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid human identity mapping');
    for (const [profile, id] of Object.entries(mapping)) {
      if (!profile || typeof id !== 'string' || !id.trim()) throw new Error('Invalid profile identity');
      const key = JSON.stringify([profile, id]);
      if (seen.has(key)) throw new Error('Ambiguous human identity mapping');
      seen.add(key);
    }
  }
  return identities;
}

export function isAdministrator(projects, actor) {
  if (!actor.senderId) return false;
  const scoped = projects.ownerOpenIdsByProfile?.[actor.profile];
  return (scoped ?? projects.ownerOpenIds ?? []).includes(actor.senderId);
}

// Non-administrators may chat and create only the explicitly read-only analysis workflow.
// This gate is enforced after AI intent classification and before any Job is persisted.
export function canCreateTask(projects, actor, intent) {
  return intent === 'analysis' || isAdministrator(projects, actor);
}

// Clarification resumes execution, so non-admins may continue only read-only analysis Jobs.
export function canContinueTask(projects, job, actor) {
  return job?.taskIntent === 'analysis' || isAdministrator(projects, actor);
}

export function isTaskCreator(projects, record, actor) {
  if (!record?.senderId || !actor?.senderId) return false;
  const origin = record.originProfile ?? record.agentProfile ?? record.profile;
  if (origin === actor.profile) return record.senderId === actor.senderId;
  if (!origin || !actor.profile) return false;
  const identities = projects.humanIdentities ?? {};
  try { validateHumanIdentities(identities); } catch { return false; }
  return Object.values(identities).some((mapping) => mapping[origin] === record.senderId && mapping[actor.profile] === actor.senderId);
}
