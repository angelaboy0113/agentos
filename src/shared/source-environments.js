// Source environment IDs and runtime access tiers are separate namespaces.
const aliases={sit:'uat',uat:'uat',test:'uat',testing:'uat',prd:'prd',prod:'prd',production:'prd'};
function mappingError(code,reason,correction){return Object.assign(new Error(reason),{queryDiagnostic:{code,reason,correction}});}
export function sourceRuntimeTier(project,id){
 const configured=project?.analysisEnvironments;
 if(configured&&!Object.hasOwn(configured,id))throw mappingError('SOURCE_ENVIRONMENT_UNKNOWN','所选源码环境未在本项目登记。','核对本项目源码环境目录，不回退到其它环境。');
 const explicit=configured?.[id]?.runtimeTier,known=Object.hasOwn(aliases,String(id).toLowerCase())?aliases[String(id).toLowerCase()]:undefined;
 if(explicit!==undefined&&(!['uat','prd'].includes(explicit)||known&&explicit!==known))throw mappingError('SOURCE_TIER_CONFIG','源码环境的运行分级配置无效或与标准环境名称冲突。','维护者核对 analysisEnvironments 中的 runtimeTier；不得把生产环境映射为测试环境。');
 const tier=explicit??known;
 if(!tier)throw mappingError('SOURCE_TIER_UNMAPPED','自定义源码环境尚未配置运行环境分级。','维护者在该源码环境配置 runtimeTier 为 uat（测试）或 prd（生产），不能从分支名猜测。');
 return tier;
}
export function assertSourceRuntimeTier(project,selected,tier){
 if(!selected)return;
 if(sourceRuntimeTier(project,selected)!==tier)throw mappingError('ENVIRONMENT_MISMATCH','运行环境与本问题选择的源码环境不一致，未执行访问。','保持原问题环境，核对所选数据源或网页；不能切换测试与生产来绕过校验。');
}
export function sourceEnvironmentForTier(project,tier,selected){
 if(selected){assertSourceRuntimeTier(project,selected,tier);return selectSourceEnvironment(project,selected);}
 if(project?.analysisSourceMode!=='isolated')return undefined;
 const candidates=Object.keys(project.analysisEnvironments??{}).filter(id=>sourceRuntimeTier(project,id)===tier);
 if(candidates.length!==1)throw mappingError('SOURCE_ENVIRONMENT_SELECTION',candidates.length?'该运行分级对应多个源码环境，请明确本次源码环境。':'该运行分级没有匹配的源码环境。','从本项目源码环境目录明确选择，不自动使用默认环境或其它环境。');
 return candidates[0];
}
function mappingInfo(project,id){try{return {runtimeTier:sourceRuntimeTier(project,id)};}catch(error){return {runtimeTier:null,mappingIssue:error.queryDiagnostic?.code??'SOURCE_TIER_CONFIG'};}}
export function sourceEnvironmentCatalog(project) {
  if (project?.analysisSourceMode !== 'isolated') return [];
  return Object.entries(project.analysisEnvironments ?? {}).map(([id, value]) => ({ id, ...mappingInfo(project,id), description: value.description ?? id, default: project.defaultSourceEnvironment === id,
    ...(value.unavailableRepositories?.length ? { unavailableRepositories: value.unavailableRepositories } : {}) }));
}
export function selectSourceEnvironment(project, selected) {
  if (project?.analysisSourceMode !== 'isolated') return undefined;
  const id = selected || project.defaultSourceEnvironment;
  if (!id || !Object.hasOwn(project.analysisEnvironments ?? {}, id)) {
    throw new Error(`请明确本次要分析哪个源码环境：${sourceEnvironmentCatalog(project).map(x => `${x.id}（${x.description}）`).join('、') || '尚未配置，请管理员配置 analysisEnvironments'}。本次尚未启动分析。`);
  }
  return id;
}
