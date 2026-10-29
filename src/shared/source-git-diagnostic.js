// Never persist stderr, command arguments, remote URLs or credential helpers.
const labels = {
  SOURCE_GIT_AUTH: '认证失败或当前凭据不可用',
  SOURCE_GIT_REMOTE_UNAVAILABLE: '远端来源、分支或指定提交不可用',
  SOURCE_GIT_TIMEOUT: '单次 Git 请求超时',
  SOURCE_GIT_NETWORK: '网络连接或远端服务暂时失败',
  SOURCE_GIT_STORAGE: '磁盘空间不足或文件系统写入失败',
  SOURCE_GIT_PERMISSION: '本机文件访问权限不足',
  SOURCE_GIT_OBJECTS: 'Git 对象缺失或损坏',
  SOURCE_GIT_FILTER: '源码检出过滤器或大文件下载失败',
  SOURCE_GIT_UNAVAILABLE: 'Git 执行失败，具体原因未能归类',
  SOURCE_SNAPSHOT_PATH: '缓存文件或来源路径不存在',
  SOURCE_BRANCH_MOVED: '远端分支已变化，无法取得先前核对的固定提交',
};
export function classifySourceGitError(error, operation) {
  const text = String(error.stderr ?? '');
  const code = error.killed || error.signal === 'SIGKILL' ? 'SOURCE_GIT_TIMEOUT'
    : /authentication failed|could not read Username|terminal prompts disabled|HTTP[^\n]*\b40[13]\b/i.test(text) ? 'SOURCE_GIT_AUTH'
    : /no space left|disk quota|read-only file system|ENOSPC|EDQUOT/i.test(text) ? 'SOURCE_GIT_STORAGE'
    : /permission denied|operation not permitted|EACCES|EPERM/i.test(text) ? 'SOURCE_GIT_PERMISSION'
    : /smudge|filter-process|filter .* failed|git-lfs/i.test(text) ? 'SOURCE_GIT_FILTER'
    : /not our ref|couldn't find remote ref|repository[^\n]*not found|does not appear to be a git repository/i.test(text) ? 'SOURCE_GIT_REMOTE_UNAVAILABLE'
    : /object[^\n]*(corrupt|missing)|bad object|invalid object|unable to read[^\n]*object|pack[^\n]*(corrupt|mismatch)/i.test(text) ? 'SOURCE_GIT_OBJECTS'
    : /could not resolve host|failed to connect|connection (reset|timed out|refused)|remote end hung up|unexpected disconnect|early EOF|TLS|SSL|HTTP[^\n]*\b(429|5\d\d)\b|requested URL returned error: (429|5\d\d)/i.test(text) ? 'SOURCE_GIT_NETWORK'
    : 'SOURCE_GIT_UNAVAILABLE';
  return {code, operation, retryable: ['fetch', 'ls-remote'].includes(operation) && ['SOURCE_GIT_NETWORK', 'SOURCE_GIT_TIMEOUT'].includes(code),
    exitCode: Number.isInteger(error.code) ? error.code : null};
}
export function sourceGitError(details) {
  return Object.assign(new Error(`Git 操作失败：${labels[details.code] ?? labels.SOURCE_GIT_UNAVAILABLE}；未输出认证信息。`),
    {code: details.code, sourceFailure: details});
}
export function snapshotFailure(repo, stage, error) {
  const old = error.sourceFailure;
  const localCode = ['ENOSPC','EDQUOT','EROFS'].includes(error.code) ? 'SOURCE_GIT_STORAGE' : ['EACCES','EPERM'].includes(error.code) ? 'SOURCE_GIT_PERMISSION' : ['ENOENT','ENOTDIR'].includes(error.code) ? 'SOURCE_SNAPSHOT_PATH' : 'SOURCE_SNAPSHOT_BOUNDARY';
  const details = {code: old?.code ?? localCode, repository: repo.path, branch: repo.branch,
    stage, operation: old?.operation ?? null, attempts: old?.attempts ?? 1, retryable: old?.retryable ?? false,
    exitCode: old?.exitCode ?? null};
  return Object.assign(new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；阶段：${stage}；${labels[details.code] ?? '缓存路径、Git 元数据或对象独立性检查未通过'}。未覆盖旧快照或个人源码。`),
    {code: details.code, sourceFailure: details});
}
