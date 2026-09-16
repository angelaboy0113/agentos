export function sourceEnvironmentCatalog(project) {
  if (project?.analysisSourceMode !== 'isolated') return [];
  return Object.entries(project.analysisEnvironments ?? {}).map(([id, value]) => ({ id, description: value.description ?? id, default: project.defaultSourceEnvironment === id }));
}
export function selectSourceEnvironment(project, selected) {
  if (project?.analysisSourceMode !== 'isolated') return undefined;
  const id = selected || project.defaultSourceEnvironment;
  if (!id || !Object.hasOwn(project.analysisEnvironments ?? {}, id)) {
    throw new Error(`请明确本次要分析哪个源码环境：${sourceEnvironmentCatalog(project).map(x => `${x.id}（${x.description}）`).join('、') || '尚未配置，请管理员配置 analysisEnvironments'}。本次尚未启动分析。`);
  }
  return id;
}
