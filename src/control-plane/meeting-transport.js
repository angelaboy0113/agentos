import { writeFile, rm } from 'node:fs/promises';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import { runLarkCli } from './lark-cli.js';

export const meetingError = code => Object.assign(new Error(code), { meetingCode: code });
const normalized = text => String(text ?? '').replace(/\s+/g, '');

export function createMeetingTransport(context, settings, run = runLarkCli) {
  const profile = settings.profile;
  const options = {profile, cliEntry:context.config.feishu.cliEntry};
  const call = (args, extra) => run([...args, '--as', 'bot', '--json'], {...options, ...extra});
  const api = async (method, route, params, body) => (await call(['api', method, route,
    ...(params ? ['--params', JSON.stringify(params)] : []), ...(body ? ['--data', JSON.stringify(body)] : [])])).data;
  const drive = async (operation, token, extra = []) => (await call(['drive', operation, '--token', token, '--type', 'docx', ...extra])).data;
  const waitForMeeting = error => /\b(?:121003|121027)\b/.test(error.message);
  const notices = new Map([['121003','waiting_admission'],['121027','waiting_ai_summary']]);

  async function details(id) {
    const data = await api('GET', '/open-apis/vc/v1/meetings/'+id, {with_participants:true, user_id_type:'open_id'});
    if (data?.meeting?.id !== id) throw meetingError('meeting_details_unavailable');
    return data.meeting;
  }

  async function ensureAudience(session, token, audience) {
    const permissions = (await drive('+permission-get-setting', token))?.permission_public;
    if (permissions?.link_share_entity !== 'closed' || permissions?.external_access_entity !== 'closed') {
      throw meetingError('document_acl_unverified');
    }
    const data = await drive('+member-list', token);
    if (!Array.isArray(data?.items) || data.has_more) throw meetingError('document_acl_unverified');
    const allowed = data.items.every(item => item.member_type === 'appid' && item.member_id === session.appId
      || item.member_type === audience.type && item.member_id === audience.id);
    if (!allowed) throw meetingError('document_acl_unverified');
    return data.items.some(item => item.member_type === audience.type && item.member_id === audience.id
      && ['edit', 'full_access', audience.perm].includes(item.perm));
  }

  async function readBody(token) {
    return (await api('GET', '/open-apis/docx/v1/documents/'+token+'/raw_content'))?.content ?? '';
  }

  return {
    async lookup(number, sender, now) {
      const end = Math.floor(now / 1000);
      const data = await api('GET', '/open-apis/vc/v1/meetings/list_by_no', {
        meeting_no:number, start_time:String(end - 90*24*60*60 + 1), end_time:String(end), page_size:100,
      });
      if (!Array.isArray(data?.meeting_briefs) || data.has_more) throw meetingError('meeting_lookup_unavailable');
      const candidates = data.meeting_briefs.filter(item => item.meeting_no === number && item.status === 2);
      if (candidates.length === 0) return null;
      if (candidates.length !== 1 || !/^\d+$/.test(candidates[0].id)) throw meetingError('meeting_lookup_unavailable');
      const meeting = await details(candidates[0].id);
      if (meeting.meeting_no !== number || meeting.status !== 2) return null;
      if (!(meeting.participants ?? []).some(item => item.id === sender && item.user_type === 1
        && item.status === 2 && item.is_external === false)) throw meetingError('meeting_requester_unverified');
      return meeting;
    },
    details,
    async join(session) {
      try {
        const response = await call(['vc', '+meeting-join', '--meeting-number', session.number]);
        const meeting = response.data?.meeting;
        if (!meeting?.id) throw meetingError('meeting_join_unverified');
        if (meeting.id !== session.meetingId || meeting.meeting_no !== session.number) {
          if (/^\d+$/.test(meeting.id)) {
            await call(['vc', '+meeting-leave', '--meeting-id', meeting.id]).catch(() => {});
          }
          throw meetingError('meeting_identity_changed');
        }
      } catch (error) {
        if (!waitForMeeting(error)) throw error;
        throw meetingError(notices.get(error.message.match(/\b(?:121003|121027)\b/)[0]));
      }
    },
    async events(session, window) {
      const result = await call(['vc', '+meeting-events', '--meeting-id', session.meetingId, '--page-size', '100',
        '--start', new Date(window.start).toISOString(), '--end', new Date(window.end).toISOString(),
        ...(window.cursor ? ['--page-token', window.cursor] : [])]);
      return result.data;
    },
    async reply(messageId, body) {
      return context.feishu.reply(messageId, body, {profile, replyInThread:true});
    },
    async direct(session, message, key) {
      const sent = await context.feishu.sendCheckinMessage({profile, receiveId:session.senderId,
        receiveIdType:'open_id', type:'text', content:{text:message}, uuid:session.id+'-'+key});
      if (!(sent?.data?.message_id ?? sent?.message_id)) throw meetingError('meeting_dm_unverified');
    },
    async sendFile(session, title, sections, directory, kind = 'minutes') {
      const filename = session.id+(kind === 'preview' ? '-会议初稿预览.docx' : '-会议纪要.docx');
      const document = new Document({sections:[{children:[
        new Paragraph({text:title, heading:HeadingLevel.TITLE}),
        ...sections.flatMap(({head, lines}) => [
          new Paragraph({text:head, heading:HeadingLevel.HEADING_1}),
          ...lines.map(text => new Paragraph({text})),
        ]),
      ]}]});
      const file = directory+'/'+filename;
      await writeFile(file, await Packer.toBuffer(document), {mode:0o600});
      try {
        const sent = await context.feishu.replyFile(session.messageId, file, {profile, privateRecipient:session.senderId,
          idempotencyKey:session.id+'-'+kind+'-file', privateStaging:true});
        if (!(sent?.data?.message_id ?? sent?.message_id)) throw meetingError('meeting_file_unverified');
      } finally {
        await rm(file, {force:true});
      }
    },
    async document(session, title, sections, audience, state, save) {
      const lines = sections.flatMap(section => [section.head, ...section.lines]);
      const xmlEscape = str => str.replace(/[<>&]/g, char => ({'<':'&lt;', '>':'&gt;', '&':'&amp;'})[char]);
      const body = sections.map(({head, lines}) => '<h1>'+xmlEscape(head)+'</h1>\n'
        +lines.map(line => '<p>'+xmlEscape(line)+'</p>').join('\n')).join('\n');
      if (!state.token) {
        if (state.creating) throw meetingError('document_creation_unverified');
        state.creating = true;
        await save();
        const result = await api('POST', '/open-apis/docx/v1/documents', null, {title});
        const token = result?.document?.document_id;
        if (!/^[A-Za-z0-9]+$/.test(token ?? '')) throw meetingError('document_creation_unverified');
        state.token = token;
        await save();
      }
      const {token} = state;
      let granted = await ensureAudience(session, token, audience);
      const verified = async () => {
        const content = normalized(await readBody(token));
        return lines.every(line => content.includes(normalized(line)));
      };
      if (!await verified()) {
        if (granted) throw meetingError('shared_document_readback_changed');
        await call(['docs', '+update', '--doc', token, '--command', 'overwrite', '--doc-format', 'xml', '--content', '-'],
          {input:body, timeoutMs:90_000});
        if (!await verified()) throw meetingError('document_content_unverified');
      }
      if (!granted) {
        await drive('+member-add', token, ['--member-id', audience.id, '--member-type', audience.type,
          '--perm', audience.perm, '--yes']);
        granted = await ensureAudience(session, token, audience);
      }
      if (!granted) throw meetingError('document_acl_unverified');
      return new URL('/docx/'+token, settings.documentOrigin).href;
    },
  };
}
