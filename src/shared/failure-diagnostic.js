// Only fixed, reviewed text reaches cards. Never echo exception bodies, URLs or credentials.
const rules = [
  ['RESULT_CONTRACT', /Invalid partial (analysis|environment) evidence/, '结果提交校验', '程序拒绝了部分结果的证据格式，并非已确认的远端连接失败。', '联系维护者核对版本与结果协议；修复后重新发起查询。'],
  ['AUTH_REQUIRED', /认证未成功|Invalid login|Login required|credential|本机凭据|ChatGPT 登录|Unapproved login/i, '登录与凭据', '登录未完成或本机凭据不可用。', '在 AgentOS 所在电脑重新登录对应服务或解锁钥匙串。'],
  ['READ_PERMISSION', /只读账号权限|数据库账号含写权限|无权限|ER_ACCESS_DENIED_ERROR|HTTP 40[13]/i, '读取权限检查', '服务拒绝读取，或账号未通过只读权限核验。', '请管理员核对读取权限；数据库查询使用专用只读账号。'],
  ['TIMEOUT', /timeout|timed out|超时|ETIMEDOUT/i, '等待响应', '本次操作超过等待时限。', '检查本机网络与服务状态，缩小查询范围后重新发起。'],
  ['NETWORK', /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|Operation not permitted/i, '网络连接', '执行环境未能建立网络连接。', '检查 AgentOS 所在电脑的内网连接、服务地址和网络权限。'],
  ['SCOPE_LIMIT', /超出范围|次数.*上限|超过次数|Write control|Redirect blocked|未开放|尚未批准|已过期|未通过|查询表或列|筛选条件/i, '授权与范围检查', '请求未通过当前只读范围、有效期或工具限额检查。', '补充具体查询目标；需要扩大范围时由管理员重新授权。'],
  ['PAGE_REFERENCE', /引用已失效|Not clickable|Invalid search|Unknown browser tool/i, '页面操作', '页面引用或操作参数已失效。', '重新打开页面并获取当前元素；不要复用旧引用。'],
  ['HTTP_RESPONSE', /HTTP [45][0-9]{2}|Read failed|环境接口未成功响应/i, '服务响应', '远端接口返回失败状态。', '检查服务状态和接口兼容性；未据此判断数据库是否可连接。'],
];
export function failureDiagnostic(error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? '');
  const matched = rules.find(([code, pattern]) => message.startsWith(`[${code}]`) || pattern.test(message));
  const [code, , phase, cause, next] = matched ?? ['EXECUTION_ERROR', null, '任务执行', '执行器遇到未分类错误，原因尚未确认。', '请维护者按任务编号检查本机日志；不要在群内发送原始日志或凭据。'];
  return `错误码：${code}\n失败环节：${phase}\n原因：${cause}\n建议：${next}`;
}
export function safeExecutionError(error) {
  const message = failureDiagnostic(error);
  const code = /^错误码：(\w+)/.exec(message)[1];
  return new Error(`[${code}] ${message}`);
}
