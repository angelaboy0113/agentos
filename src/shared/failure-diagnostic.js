const stages = Object.freeze({
  'browser.launch': '启动后台浏览器', 'browser.open-login': '打开登录页面',
  'browser.login-form': '等待登录表单', 'browser.login-submit': '提交浏览器登录',
  'browser.login-result': '核验浏览器登录', 'browser.open-config': '打开配置列表',
  'browser.click': '点击页面控件', 'browser.search': '搜索页面', 'browser.snapshot': '读取页面', 'browser.operation': '浏览器操作',
  'browser.reuse-session': '复用已登录页面',
  connection: '环境连接检查', discover: '发现配置', read_config: '读取配置',
  browser_open: '打开后台浏览器页面', browser_click: '点击页面控件',
  browser_snapshot: '读取页面', browser_search: '搜索页面',
  select: '数据库只读查询', schema: '读取表结构', tables: '发现数据表', planning: '规划下一步排查'
});
// Only fixed, reviewed text reaches cards. Never echo exception bodies, URLs or credentials.
const rules = [
  ['QUERY_ALREADY_STARTED', /QUERY_ALREADY_STARTED/, '任务接续校验', '任务已启动，但本次领取没有有效的登录接续凭证；未继续访问网站。', '请维护者检查登录接续状态，不需要用户补充查询范围。'],
  ['LEASE_EXPIRED', /查询租约已失效/, '任务领取校验', '当前执行器的任务租约已失效，未继续查询。', '检查任务恢复与执行器状态，不能通过重复批准解决。'],
  ['COLUMN_LIMIT', /\[COLUMN_LIMIT\]/, '查询字段校验', '单次查询字段超过12个，查询未执行；不是授权不足。', '减少为相关字段后继续，可按相同筛选条件分次查询。'],
  ['SCHEMA_REQUIRED', /\[SCHEMA_REQUIRED\]/, '查询结构校验', '尚未读取目标表结构，查询未执行。', '先读取目标表schema，再使用返回字段查询。'],
  ['SCHEMA_FIELDS', /\[SCHEMA_FIELDS\]/, '查询字段校验', '查询字段尚未在已读取结构中确认，查询未执行。', '读取目标表结构或下一页，并使用实际字段。'],
  ['QUERY_INPUT', /\[QUERY_INPUT\]/, '查询参数校验', '筛选条件或字段参数格式不符合工具要求，查询未执行。', '在原授权范围内修正参数，无需因此重新授权。'],
  ['RESULT_LIMIT', /工具结果超出大小限制|结果超出大小|Response limit/, '工具结果整理', '结果超过单次返回大小限制，并非连接失败。', '缩小查询范围或分页读取；表结构可指定目标表继续。'],
  ['TLS_UNSUPPORTED', /HANDSHAKE_NO_SSL_SUPPORT|does not support secure connection/i, '数据库TLS握手', '数据库服务器不支持当前要求的TLS加密连接；尚未开始查询。', '请运维启用TLS；如需内网非TLS例外，必须由管理员另行明确确认，程序不会自动降级。'],
  ['TLS_VALIDATION', /certificate|SSL|TLS|HANDSHAKE/i, '数据库加密连接', '数据库TLS连接或证书校验未通过。', '请管理员核对服务器TLS支持和信任证书；程序不会自动关闭验证。'],
  ['CREDENTIAL_SOURCE', /凭据引用|外部或加密凭据|目标数据库凭据|凭据字段|配置凭据|Nacos配置已改变/, '配置凭据解析', '配置已改变，或无法唯一解析目标数据库凭据。', '重新发现并确认配置；外部密钥或多个账号需要管理员指定正确来源。'],
  ['RESULT_CONTRACT', /Invalid partial (analysis|environment) evidence/, '结果提交校验', '程序拒绝了部分结果的证据格式，并非已确认的远端连接失败。', '联系维护者核对版本与结果协议；修复后重新发起查询。'],
  ['AUTH_REQUIRED', /认证未成功|Invalid login|Login required|credential|本机凭据|ChatGPT 登录|Unapproved login/i, '登录与凭据', '登录未完成或本机凭据不可用。', '在 AgentOS 所在电脑重新登录对应服务或解锁钥匙串。'],
  ['READ_PERMISSION', /只读账号权限|数据库账号含写权限|无权限|ER_ACCESS_DENIED_ERROR|HTTP 40[13]/i, '读取权限检查', '服务拒绝读取，或账号未通过只读权限核验。', '请管理员核对读取权限；核对当前账号策略与授权，不要关闭只读事务。'],
  ['TIMEOUT', /timeout|timed out|超时|ETIMEDOUT/i, '等待响应', '本次操作超过等待时限。', '检查本机网络与服务状态，缩小查询范围后重新发起。'],
  ['NETWORK', /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|Operation not permitted/i, '网络连接', '执行环境未能建立网络连接。', '检查 AgentOS 所在电脑的内网连接、服务地址和网络权限。'],
  ['SCOPE_LIMIT', /超出范围|次数.*上限|超过次数|Write control|Redirect blocked|未开放|尚未批准|已过期|未通过|查询表或列|筛选条件/i, '授权与范围检查', '请求未通过当前只读范围、有效期或工具限额检查。', '补充具体查询目标；需要扩大范围时由管理员重新授权。'],
  ['PAGE_REFERENCE', /引用已失效|Not clickable|Invalid search|Unknown browser tool/i, '页面操作', '页面引用或操作参数已失效。', '重新打开页面并获取当前元素；不要复用旧引用。'],
  ['HTTP_RESPONSE', /HTTP [45][0-9]{2}|Read failed|环境接口未成功响应/i, '服务响应', '远端接口返回失败状态。', '检查服务状态和接口兼容性；未据此判断数据库是否可连接。'],
];
export function failureDiagnostic(error) {
  const message = typeof error === 'string' ? error : `${String(error?.code ?? '')} ${String(error?.message ?? '')}`;
  const matched = rules.find(([code, pattern]) => message.trimStart().startsWith(`[${code}]`) || pattern.test(message));
  const [code, , phase, cause, next] = matched ?? ['EXECUTION_ERROR', null, '任务执行', '执行器遇到未分类错误，原因尚未确认。', '请维护者按任务编号检查本机日志；不要在群内发送原始日志或凭据。'];
  return `错误码：${code}\n失败环节：${Object.hasOwn(stages, error?.diagnosticStage) ? stages[error.diagnosticStage] : phase}\n原因：${cause}\n建议：${next}`;
}
export function safeExecutionError(error) {
  const message = failureDiagnostic(error);
  const code = /^错误码：(\w+)/.exec(message)[1];
  return Object.assign(new Error(`[${code}] ${message}`), Object.hasOwn(stages, error?.diagnosticStage) ? { diagnosticStage: error.diagnosticStage } : {});
}
