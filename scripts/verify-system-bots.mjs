// Run after app publication, isolated CLI configuration, and adding both bots to the group.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runLarkCli } from '../src/control-plane/lark-cli.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const configDir = path.resolve(root, '../runtime/lark-cli');
const agentFile = path.join(root, 'config/agents.local.json');
const projectFile = path.join(root, 'config/projects.local.json');
const agents = JSON.parse(await readFile(agentFile, 'utf8'));
const projects = JSON.parse(await readFile(projectFile, 'utf8'));
const ownerIdentity = {};
for (const agent of Object.values(agents.agents)) {
  const options = { profile: agent.profile, configDir };
  const auth = await runLarkCli(['auth', 'status', '--verify', '--json'], options);
  if (auth.appId !== agent.appId || !auth.identities?.bot?.verified || !auth.identities.bot.openId) throw new Error(`机器人身份尚未核验：${agent.displayName}`);
  agent.openId = auth.identities.bot.openId;
  const owners = new Set();
  for (const chatId of agent.allowedChatIds) {
    const response = await runLarkCli(['im', 'chats', 'get', '--chat-id', chatId, '--user-id-type', 'open_id', '--as', 'bot', '--json'], options);
    const chat = response.data?.data ?? response.data;
    if (!chat?.owner_id?.startsWith('ou_') || chat.owner_id === agent.openId) throw new Error('未能核实真人群主，不授予写权限');
    owners.add(chat.owner_id);
  }
  // open_id is app-scoped: do not copy the existing CLI app's owner id.
  projects.ownerOpenIdsByProfile[agent.profile] = [...owners];
  if (owners.size !== 1) throw new Error('本部署要求唯一群主，请核对各群归属');
  ownerIdentity[agent.profile] = [...owners][0];
  console.log(`${agent.displayName}：机器人和本应用内群主身份核验通过`);
}
projects.humanIdentities ??= {};
projects.humanIdentities.groupOwner = ownerIdentity;
// Write only after every bot has passed. The preflight refuses any incomplete pair.
for (const [file, value] of [[agentFile, agents], [projectFile, projects]]) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
