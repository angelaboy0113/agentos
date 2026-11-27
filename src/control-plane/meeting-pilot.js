import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectId } from '../shared/project-scope.js';
import { createMeetingTransport, meetingError } from './meeting-transport.js';
import { KnowledgeModel } from './knowledge-model.js';

const TICK_MS = 5000;
const TAIL_MS = 25_000;
const OVERLAP_MS = 60_000;
const VC_GRACE_MS = 5*60_000;
const activeStates = new Set(['joining', 'recording', 'summarizing', 'delivering', 'publishing']);
const labels = {conclusions:'会议结论', decisions:'已确认的业务口径', actions:'待办',
  unresolved:'待确认事项', shareableRequirements:'建议发布的会议初稿'};
const statusText = {
  waiting_ai_summary:'请主持人打开飞书「AI 总结」，助手会继续尝试入会。',
  waiting_admission:'正在等待入会，请主持人确认会控设置或放行。',
  meeting_requester_unverified:'暂无法核实你正在会议中，请入会后重新发送记录指令。',
  recording:'助手已入会。散会后会私聊发送纪要。',
  ended_without_transcript:'会议已结束，助手未取得发言转写。请检查主持人是否开启了 AI 总结。',
  meeting_identity_changed:'会议号对应的场次已变化，请核对后重新发送记录指令。',
  meeting_read_scope:'助手暂时无法核验本场会议和参会身份，请维护者检查飞书会议读取权限。',
};

export async function loadMeetingPilot(config) {
  const file = config.meetingPilotFile;
  if (!file) return null;
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!value.enabled) return null;
  const origin = new URL(value.documentOrigin);
  if (!/^oc_[A-Za-z0-9]+$/.test(value.chatId ?? '')
    || (value.allSystemAssistants !== true && (!/^[\w-]+$/.test(value.profile ?? '') || !/^[\w-]+$/.test(value.projectId ?? '')))
    || origin.origin !== value.documentOrigin
    || origin.protocol !== 'https:' || !/\.(?:feishu\.cn|larksuite\.com)$/.test(origin.hostname)) {
    throw Error('Invalid AgentOS meeting pilot settings');
  }
  return value;
}

export function meetingSettingsForAssistants(context, settings) {
  if (settings.allSystemAssistants !== true) return [settings];
  return Object.values(context.agents.agents ?? {})
    .filter(agent => agent.systemAssistant && agent.profile && agent.appId
      && (!agent.allowedChatIds || agent.allowedChatIds.includes(settings.chatId)))
    .flatMap(({profile}) => {
      const projectId = context.projects.chatProfileProjectMap?.[settings.chatId]?.[profile];
      return projectId ? [{chatId:settings.chatId, documentOrigin:settings.documentOrigin, profile, projectId}] : [];
    });
}

function command(text) {
  const input = text.trim();
  const numberOnly = input.match(/^会议号\s*[:：]?\s*([0-9\s]+)$/);
  if (numberOnly) {
    const number = numberOnly[1].replace(/\s/g, '');
    return /^\d{9}$/.test(number) ? {number} : {invalid:true};
  }
  const record = input.match(/^(?:记录会议|入会记录)\s+(.+)$/);
  if (record) {
    const number = record[1].replace(/\s/g, '');
    if (/^\d{9}$/.test(number)) return {number};
    try {
      const url = new URL(record[1]);
      const match = url.pathname.match(/\/(\d{9})\/?$/);
      if (url.protocol === 'https:' && ['vc.feishu.cn','vc.larksuite.com'].includes(url.host) && match) return {number:match[1]};
    } catch {}
    return {invalid:true};
  }
  const publish = input.match(/^发布会议初稿\s+(mtg-[0-9a-f]{16})$/);
  return publish && {publish:publish[1]};
}

const hash = text => createHash('sha256').update(text).digest('hex');
const singleLine = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
function timestamp(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (numeric > 0) return numeric >= 1e12 ? numeric : numeric*1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const localTime = ms => new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});

function extractTranscript(session, page, window, now) {
  const meeting = page?.meeting;
  if (meeting?.id !== session.meetingId || !Array.isArray(page.events)) throw meetingError('meeting_event_unverified');
  if (page.has_more === true && (!page.page_token || window.seenCursors.includes(page.page_token))) {
    throw meetingError('meeting_event_cursor_invalid');
  }
  for (const event of page.events) {
    for (const item of event.payload?.transcript_received_items ?? []) {
      const id = String(item.sentence_id ?? '');
      const text = singleLine(item.text);
      const start = /^\d+$/.test(String(item.start_time_ms)) ? Number(item.start_time_ms) : Date.parse(item.start_time_ms);
      const revision = timestamp(event.event_time) ?? 0;
      if (!/^[\w-]+$/.test(id) || !text || !Number.isFinite(start) || start < 0) continue;
      const previous = Object.hasOwn(session.sentences,id) ? session.sentences[id] : null;
      if (previous && previous.revision > revision) continue;
      session.sentences[id] = {text, start, speaker:singleLine(item.speaker?.user_name), revision};
    }
  }
  if (!session.endedAt && (['ended','finished','completed','end',3,'3'].includes(meeting.status) || timestamp(meeting.end_time))) {
    session.endedAt = timestamp(meeting.end_time) ?? now;
    session.terminalSeenAt = now;
  }
  if (page.has_more === true) {
    window.cursor = page.page_token;
    window.seenCursors.push(window.cursor);
  } else {
    session.window = null;
    session.watermark = window.end;
    if (session.terminalSeenAt && window.end >= session.terminalSeenAt+TAIL_MS) {
      session.phase = 'summarizing';
    }
  }
}

function sectionsFor(session, preview = false) {
  const entries = session.summary;
  const sections = [{head:'材料来源与覆盖', lines:[preview
    ? '此文档仅包含发起人审阅后明确发布的需求口径，可作为 PRD 初稿继续使用。'
    : '仅根据助手收到的飞书转写整理。入会前、转写未开启期间及共享屏幕内容可能缺失。'
      +'助手入会 '+localTime(session.joinedAt)+'，散会 '+localTime(session.endedAt)+'。'
      +'共收到 '+Object.keys(session.sentences).length+' 条去重发言。'
      +(session.incomplete ? '飞书转写读取窗口已过，末段覆盖无法核实。' : '')]}];
  const categories = preview ? ['shareableRequirements'] : Object.keys(labels).filter(k => k !== 'shareableRequirements');
  for (const category of categories) {
    const rows = entries[category];
    sections.push({head:preview?'已确认的业务口径':labels[category],
      lines: rows.length ? rows.map(item => {
        if (preview) return item.text;
        const owners = category === 'actions' ? '｜负责人 '+(item.owner || '待确认')+'｜截止 '+(item.due || '待确认') : '';
        const evidence = [...new Set(item.sentenceIds.map(id => {
          const time = session.sentences[id].start;
          return time > 1e12 ? localTime(time) : '转写位置 '+Math.floor(time/1000)+' 秒';
        }))].join('、');
        return item.text+owners+'（'+evidence+'）';
      }) : ['无']});
  }
  return sections;
}

function validateSummary(summary, sentences) {
  return Object.fromEntries(Object.keys(labels).map(kind => {
    if (!Array.isArray(summary?.[kind])) throw meetingError('meeting_summary_invalid');
    return [kind, summary[kind].flatMap(item => {
      const text = singleLine(item.text);
      const sentenceIds = Array.isArray(item.sentenceIds) ? [...new Set(item.sentenceIds.filter(id => Object.hasOwn(sentences,id)))] : [];
      return text && sentenceIds.length ? [{text, sentenceIds, owner:singleLine(item.owner), due:singleLine(item.due)}] : [];
    })];
  }));
}

export class MeetingPilot {
  constructor(context, settings, dependencies = {}) {
    this.context = context;
    this.settings = settings;
    this.directory = path.join(context.config.dataDir, 'meeting-sessions');
    this.transport = dependencies.transport ?? createMeetingTransport(context, settings);
    this.model = dependencies.model ?? new KnowledgeModel(context.config);
    this.now = dependencies.now ?? Date.now;
    this.sessions = new Map();
    this.inFlight = new Map();
    this.ready = this.restore();
  }

  async restore() {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    for (const name of await readdir(this.directory)) {
      if (!/^mtg-[0-9a-f]{16}\.json$/.test(name)) continue;
      const item = JSON.parse(await readFile(path.join(this.directory,name),'utf8'));
      if (item.id+'.json' === name && item.profile === this.settings.profile && item.chatId === this.settings.chatId
        && item.projectId === this.settings.projectId) this.sessions.set(item.id, item);
    }
  }

  async save(item) {
    const file = path.join(this.directory,item.id+'.json');
    const pending = file+'.tmp';
    await writeFile(pending, JSON.stringify(item), {mode:0o600});
    await rename(pending,file);
  }

  start() {
    this.timer = setInterval(() => void this.tick().catch(() => console.error('[meeting] recovery unavailable')), TICK_MS);
    this.timer.unref();
    void this.tick().catch(() => console.error('[meeting] recovery unavailable'));
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.model.close?.();
    await Promise.allSettled(this.inFlight.values());
  }

  async handle(event, {agent, content}) {
    if (event.chat_type !== 'group' || event.sender_type !== 'user' || event.chat_id !== this.settings.chatId
      || !['text', undefined].includes(event.message_type) || event.agent_profile !== this.settings.profile
      || agent?.profile !== this.settings.profile || !agent.systemAssistant || !agent.appId
      || resolveProjectId(this.context.projects,event.chat_id,event.agent_profile) !== this.settings.projectId
      || !/^ou_[A-Za-z0-9]+$/.test(event.sender_id ?? '') || !event.message_id) return null;
    const request = command(content ?? '');
    if (!request) return null;
    await this.ready;
    const configuredAgent = this.currentAgent();
    if (agent.appId !== configuredAgent?.appId) return null;
    const reply = text => this.transport.reply(event.message_id,text).catch(() => {});
    if (request.invalid) {
      await reply('请发送「记录会议」加 9 位会议号，或粘贴飞书入会链接。');
      return {meetingPilot:'invalid'};
    }
    if (request.publish) {
      const item = this.sessions.get(request.publish);
      if (item?.senderId !== event.sender_id || item.appId !== agent.appId || !item.previewSent) return {meetingPilot:'unavailable'};
      if (item.phase === 'complete') {
        item.phase = 'publishing';
        item.share ??= {};
        await this.save(item);
      }
      if (item.phase === 'published') await reply('这份会议初稿已经发布。');
      return {meetingPilot:item.phase};
    }
    let meeting;
    try {
      meeting = await this.transport.lookup(request.number,event.sender_id,this.now());
    } catch (error) {
      await reply(statusText[error.meetingCode] ?? statusText.meeting_read_scope);
      return {meetingPilot:'verification_required'};
    }
    if (!meeting) {
      await reply('暂未查到这场正在进行的会议，请开会后再发一次记录指令。');
      return {meetingPilot:'waiting_start'};
    }
    const id = 'mtg-'+hash(this.settings.profile+'\n'+meeting.id).slice(0,16);
    if (this.sessions.has(id)) {
      await reply('这场会议已有记录任务。');
      return {meetingPilot:'duplicate'};
    }
    const item = {id, number:request.number, meetingId:meeting.id, meetingStart:timestamp(meeting.start_time),
      profile:this.settings.profile, projectId:this.settings.projectId, chatId:event.chat_id, appId:agent.appId,
      senderId:event.sender_id, messageId:event.message_id, phase:'joining', sentences:Object.create(null)};
    this.sessions.set(id,item);
    try { await this.save(item); } catch (error) { this.sessions.delete(id); throw error; }
    this.schedule(item);
    return {meetingPilot:'accepted'};
  }

  currentAgent() {
    return Object.values(this.context.agents.agents ?? {}).find(agent => agent.systemAssistant
      && agent.profile === this.settings.profile
      && (!agent.allowedChatIds || agent.allowedChatIds.includes(this.settings.chatId)));
  }

  schedule(item) {
    if (this.currentAgent()?.appId !== item.appId
      || this.context.projects.retiredChatIds?.includes(item.chatId)
      || resolveProjectId(this.context.projects,item.chatId,item.profile) !== item.projectId) return;
    if (this.closed || !(activeStates.has(item.phase) || item.noticePending) || this.inFlight.has(item.id)
      || (item.nextAt ?? 0) > this.now() || (!activeStates.has(item.phase) && (item.noticeRetryAt ?? 0) > this.now())) return;
    const pending = this.advance(item).catch(async error => {
      if (this.closed) return;
      item.nextAt = this.now()+60_000;
      item.lastError = error.meetingCode ?? 'upstream_unavailable';
      await this.save(item);
    }).catch(() => console.error('[meeting] checkpoint unavailable')).finally(() => this.inFlight.delete(item.id));
    this.inFlight.set(item.id,pending);
  }

  async tick() {
    await this.ready;
    for (const item of this.sessions.values()) this.schedule(item);
  }

  async advance(item) {
    if (item.noticePending && (item.noticeRetryAt ?? 0) <= this.now()) {
      try {
        await this.transport.reply(item.messageId, statusText[item.noticePending]);
        item.noticePending = null;
        item.noticeRetryAt = null;
      } catch {
        item.noticeRetryAt = this.now()+60_000;
      }
      await this.save(item);
    }
    if (!activeStates.has(item.phase)) return;
    if (item.phase === 'joining') await this.join(item);
    else if (item.phase === 'recording') await this.record(item);
    else if (item.phase === 'summarizing') await this.summarize(item);
    else if (item.phase === 'delivering') await this.deliver(item);
    else if (item.phase === 'publishing') await this.publish(item);
    item.nextAt = null;
    item.lastError = null;
    await this.save(item);
  }

  async join(item) {
    const now = this.now();
    // Keep retries bound to the original immutable meeting, including a check after a restart.
    const meeting = await this.transport.details(item.meetingId);
    if (meeting.status === 3 || meeting.meeting_no !== item.number) {
      item.phase = 'stopped';
      item.noticePending = 'meeting_identity_changed';
      return;
    }
    if (meeting.status !== 2) throw meetingError('meeting_details_unavailable');
    if (!item.joinAttemptedAt && !meeting.participants?.some(p => p.id === item.senderId && p.user_type === 1
      && p.status === 2 && p.is_external === false)) {
      item.phase = 'stopped';
      item.noticePending = 'meeting_requester_unverified';
      return;
    }
    // A prior mutation may have succeeded before the process persisted the response.
    // A bound event response proves the bot is already present and avoids joining twice.
    let inMeeting = false;
    if (item.joinAttemptedAt) {
      const page = await this.transport.events(item, {start:item.joinAttemptedAt,end:now}).catch(() => null);
      inMeeting = page?.meeting?.id === item.meetingId && Array.isArray(page.events);
      if (!inMeeting && !meeting.participants?.some(p => p.id === item.senderId && p.user_type === 1
        && p.status === 2 && p.is_external === false)) {
        throw meetingError('meeting_requester_unverified');
      }
    }
    if (!inMeeting) {
      item.joinAttemptedAt = now;
      await this.save(item);
      try { await this.transport.join(item); }
      catch (error) {
        if (error.meetingCode === 'meeting_identity_changed') {
          item.phase = 'stopped';
          item.noticePending = error.meetingCode;
          return;
        }
        if (['waiting_admission','waiting_ai_summary'].includes(error.meetingCode) && item.joinWait !== error.meetingCode) {
          item.joinWait = error.meetingCode;
          item.noticePending = error.meetingCode;
        }
        throw error;
      }
    }
    item.phase = 'recording';
    item.joinedAt = item.joinAttemptedAt;
    item.noticePending = 'recording';
  }

  async record(item) {
    const now = this.now();
    try {
      item.window ??= {start:Math.max(item.joinedAt-1000,(item.watermark ?? 0)-OVERLAP_MS),end:now,cursor:null,seenCursors:[]};
      extractTranscript(item,await this.transport.events(item,item.window),item.window,now);
      if (!item.window && !item.endedAt && now-(item.lastStatusCheck ?? item.joinedAt) >= 60_000) {
        item.lastStatusCheck = now;
        const status = await this.transport.details(item.meetingId).catch(() => null);
        if (status?.status === 3) {
          item.endedAt = timestamp(status.end_time) ?? now;
          item.terminalSeenAt = now;
        }
      }
    } catch (error) {
      // An empty time window may omit meeting identity entirely. Keep the last verified
      // watermark and extend the next request to include speech that arrives afterward.
      if (['meeting_event_cursor_invalid','meeting_event_unverified'].includes(error.meetingCode)) item.window = null;
      const details = await this.transport.details(item.meetingId).catch(() => null);
      const end = timestamp(details?.end_time) ?? item.endedAt;
      if (details?.status === 3 && !item.endedAt && end) {
        item.endedAt = end;
        item.terminalSeenAt = now;
      }
      if (!end || now < end+VC_GRACE_MS) throw error;
      item.incomplete = true;
      item.phase = 'summarizing';
    }
  }

  async summarize(item) {
    const ordered = Object.entries(item.sentences).sort(([,a],[,b]) => a.start-b.start);
    if (!ordered.length) {
      item.phase = 'stopped';
      item.noticePending = 'ended_without_transcript';
      return;
    }
    let chunks = [];
    let current = [];
    let size = 0;
    for (const [id, {text, speaker}] of ordered) {
      if (size+text.length > 28_000 && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push({id,text,speaker});
      size += text.length+speaker.length+id.length;
    }
    chunks.push(current);
    item.extracts ??= [];
    while (item.extracts.length < chunks.length && !this.closed) {
      const transcript = chunks[item.extracts.length];
      const input = Object.fromEntries(transcript.map(({id}) => [id,true]));
      item.extracts.push(validateSummary(await this.model.summarizeMeeting({transcript}), input));
      await this.save(item);
    }
    if (this.closed) return;
    // Cross-part contradictions require reconciliation before marking requirements as confirmed.
    chunks = item.extracts;
    while (chunks.length > 1) {
      const merged = [];
      for (let i=0;i<chunks.length;i+=3) {
        merged.push(validateSummary(await this.model.summarizeMeeting({merge:chunks.slice(i,i+3)}),item.sentences));
      }
      chunks = merged;
    }
    item.summary = chunks[0];
    item.phase = 'delivering';
  }

  async deliver(item) {
    const title = '会议纪要 · '+localTime(item.meetingStart ?? item.joinedAt);
    const sections = sectionsFor(item);
    item.privateDoc ??= {};
    if (!item.minutesSent) {
      let link;
      if (!item.minutesFileMode) {
        try {
          link = await this.transport.document(item,title,sections,{type:'openid',id:item.senderId,perm:'view'},item.privateDoc,() => this.save(item));
        } catch {
          item.minutesFileMode = true;
          await this.save(item);
        }
      }
      if (item.minutesFileMode) await this.transport.sendFile(item,title,sections,this.directory);
      else await this.transport.direct(item,'会议纪要已整理：'+link,'memo');
      item.minutesSent = true;
      await this.save(item);
    }
    const shareable = item.summary.shareableRequirements;
    if (shareable.length && !item.previewSent) {
      const preview = shareable.map(x => '• '+x.text).join('\n');
      if (preview.length > 8000) {
        // Preserve the complete preview in the same private-file channel before asking for approval.
        await this.transport.sendFile(item,'会议初稿预览',sectionsFor(item,true),this.directory,'preview');
      }
      await this.transport.direct(item,'请审阅以下拟发布的业务口径。'+(preview.length <= 8000 ? '\n'+preview : '完整内容见单独发送的初稿预览附件。')
        +'\n如确认可让原群读取，请回到原群 @助手 发送「发布会议初稿 '+item.id+'」。','preview');
      item.previewSent = true;
    }
    // The reviewed outline is all that subsequent publication needs.
    item.summary = {shareableRequirements:shareable};
    delete item.extracts;
    delete item.sentences;
    item.phase = 'complete';
  }

  async publish(item) {
    const link = await this.transport.document(item,'会议需求初稿',sectionsFor(item,true),{type:'openchat',id:item.chatId,perm:'edit'},
      item.share,() => this.save(item));
    await this.transport.direct(item,'会议初稿已共享给原群。回群 @助手，发送「我要做一个PRD」加这个链接：'+link,'prd');
    item.phase = 'published';
  }
}
