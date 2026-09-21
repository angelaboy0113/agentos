import { credential } from '../runner/environment-connector.js';
import { isEnvironmentOwner, loadEnvironments } from '../shared/environment-access.js';
import { saveKeychainCredential } from '../shared/keychain-credential.js';

const command = /(?:网站登录|登录网站|网页登录)/i;
const marker = /(?:网址|地址|url|账号|用户名|user(?:name)?|密码|password|passwd)\s*[:：=]?\s*/ig;

export function parseWebsiteCredentialMessage(value) {
  const text = String(value ?? '').trim();
  const credentialShape = /(?:账号|用户名|user(?:name)?)\s*[:：=]?\s*\S+/i.test(text)
    && /(?:密码|password|passwd)\s*[:：=]?\s*\S+/i.test(text);
  if (!command.test(text) && !credentialShape) return null;
  command.lastIndex = 0;
  const fields = [];
  for (const match of text.matchAll(marker)) fields.push({ key: match[0], name: match[0].match(/网址|地址|url/i) ? 'url'
    : match[0].match(/密码|password|passwd/i) ? 'password' : 'username', start: match.index + match[0].length, marker: match.index });
  const result = { intent: true };
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const valueText = text.slice(field.start, fields[index + 1]?.marker ?? text.length).trim();
    if (valueText && result[field.name] == null) result[field.name] = valueText;
  }
  if (!result.url) { const found = text.match(/https?:\/\/[^\s]+/i)?.[0]; if (found) result.url = found; }
  if (typeof result.username !== 'string' || !result.username || result.username.length > 1000
    || typeof result.password !== 'string' || !result.password || result.password.length > 8000) result.invalid = true;
  return result;
}

export class WebsiteCredentialService {
  constructor(context, adapters = {}) {
    this.context = context;
    this.save = adapters.save ?? saveKeychainCredential;
    this.read = adapters.read ?? credential;
    this.load = adapters.load ?? loadEnvironments;
  }

  async handle(event) {
    const parsed = parseWebsiteCredentialMessage(event.content);
    if (!parsed) return null;
    const profile = event.agent_profile ?? null;
    const reply = async (message) => {
      await this.context.feishu.reply(event.message_id ?? event.id, message, { profile });
      return { credentialMessage: true };
    };
    if (event.chat_type !== 'p2p') return reply('检测到网站登录凭据。为避免账号密码进入群记录，本条不会交给 Agent 或任务处理；请先撤回，然后私聊当前项目负责人机器人发送。');
    if (parsed.invalid) return reply('格式未识别。请发送：网站登录 网址：https://… 账号：… 密码：…；如果当前只有一个网站在等待登录，可以省略网址。');
    const state = await this.context.store.read();
    const config = await this.load();
    let candidates = state.jobs.filter((job) => job.status === 'awaiting_clarification'
      && job.result?.browserLoginRequired === true && job.result?.browserActionRequired !== 'automation'
      && job.environmentAccess?.kind === 'website').map((job) => ({ job, environment: config.environments[job.environmentAccess.environmentId] }))
      .filter(({ environment }) => environment?.kind === 'website' && isEnvironmentOwner(environment, { profile, senderId: event.sender_id }));
    if (parsed.url) {
      let supplied;
      try { supplied = new URL(parsed.url); if (supplied.username || supplied.password || !['http:', 'https:'].includes(supplied.protocol)) throw new Error(); }
      catch { return reply('网址格式无效，请发送不含账号、密码和令牌的 http(s) 网站地址。'); }
      candidates = candidates.filter(({ environment }) => {
        const base = new URL(environment.baseUrl);
        return base.origin === supplied.origin && (supplied.pathname.startsWith(base.pathname) || base.pathname.startsWith(supplied.pathname));
      });
    }
    candidates = [...new Map(candidates.map((candidate) => [candidate.job.environmentAccess.environmentId, candidate])).values()];
    if (!candidates.length) return reply('没有找到由你负责且正在等待登录的网站任务。请先在原问题中发起网页排查，出现“等待网页登录”后再私聊提交。');
    if (candidates.length > 1) return reply('当前有多个网站正在等待登录，请在凭据消息中补充完整网址后重试。');
    const { job, environment } = candidates[0];
    await this.save(environment.credentialRef, { username: parsed.username, password: parsed.password });
    let result;
    try { result = await this.context.websiteBrowser.submitCredentials(job, environment, { username: parsed.username, password: parsed.password }, { force: true }); }
    catch { return reply('凭据已安全保存到 Mac 钥匙串，但页面自动填写暂未完成。AgentOS 会保留原任务；请确认本机 Chrome 页面仍停留在该网站登录页。'); }
    if (result.authenticated) return reply('凭据已保存到 Mac 钥匙串，网页登录成功。AgentOS 将自动继续原问题，无需回复“继续”。');
    return reply('凭据已保存并提交到登录页。页面仍在等待验证码、短信、扫码或登录结果时，请只在本机 Chrome 完成该步骤；完成后 AgentOS 会自动继续。');
  }

  async autoLogin(job, environment) {
    if (typeof this.context.websiteBrowser.submitCredentials !== 'function') return false;
    let saved;
    try { saved = await this.read(environment.credentialRef); } catch { return false; }
    try { return Boolean((await this.context.websiteBrowser.submitCredentials(job, environment, saved)).authenticated); }
    catch { return false; }
  }
}
