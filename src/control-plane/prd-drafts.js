import { CloudSheetError, cloudSheetTarget, readCloudSheet } from '../shared/feishu-cloud-sheet.js';

export function normalizePrdDraftLinks(text) {
  const links = new Set();
  const canonical = String(text ?? '').replace(/https:\/\/[^\s<>"\]），。；！？、】]+/gi, match => {
    const candidate = match.replace(/[),.;!?]+$/, '');
    const target = cloudSheetTarget(candidate);
    if (!target || target.kind === 'sheets') return match;
    const { origin, pathname } = new URL(candidate);
    const url = origin + pathname.replace(/\/$/, '');
    links.add(url);
    return url + match.slice(candidate.length);
  });
  const plainText = [...links].reduce((value, link) => value.replaceAll(link, ' '), canonical);
  return { canonical, plainText, links: [...links] };
}

export async function readPrdDraft(client, { url, profile, projectId, chatId }) {
  const doc = await readCloudSheet(client, { projectId, originProfile: profile },
    { kind: 'website', projectId, baseUrl: url }, 'read_cloud_document', {}, {
      authorizeDocument: async ({ token, documentType }) => {
        if (documentType !== 'docx') throw new CloudSheetError('PRD_DRAFT_FORMAT', '此链接指向的内容不是飞书在线文档。请贴在线文档链接，或在卡片填入需求初稿。');
        const members = await client.cloudDocumentMembers(token, { profile })
          .catch(() => { throw new CloudSheetError('PRD_DRAFT_PERMISSIONS', '助手暂时无法核验文档的共享权限。可以先在卡片贴需求初稿。'); });
        if (!members.items?.some(({ member_type, member_id, perm }) =>
          member_type === 'openchat' && member_id === chatId && ['view', 'edit', 'full_access'].includes(perm))) {
          throw new CloudSheetError('PRD_DRAFT_SHARE', '请把初稿共享给本群并保留助手的阅读权限，再在卡片中提交链接。也可以直接贴初稿。');
        }
      },
    });
  const title = doc.title || doc.blocks.find(block => block.block_type === 1)?.page?.elements
    ?.map(element => element.text_run?.content ?? '').join('') || '飞书需求初稿';
  const imageCount = doc.blocks.filter(block => block.block_type === 27).length;
  if (!doc.content?.trim()) throw new CloudSheetError('PRD_DRAFT_EMPTY', '这份文档没有读到正文。请在卡片补充需求，图片可直接发到原话题。');
  return { url, title, text: documentTextWithTables(doc), imageCount };
}

function documentTextWithTables(doc) {
  const blocks = new Map(doc.blocks.map(block => [block.block_id, block]));
  const rows = doc.blocks.flatMap(({ table }) => {
    const width = table?.property?.column_size;
    if (!Number.isSafeInteger(width) || width < 1 || !Array.isArray(table.cells)) return [];
    const tableRows = [];
    for (let index = 0; index < table.cells.length; index += width) {
      const cells = table.cells.slice(index, index + width).map(id =>
        (blocks.get(id)?.children ?? []).flatMap(child =>
          (blocks.get(child)?.text?.elements ?? []).map(element => element.text_run?.content ?? '')).join(' ').trim());
      tableRows.push(cells.join(' | '));
    }
    return ['【表格行】', ...tableRows];
  });
  return rows.length ? [doc.content, ...rows].join('\n') : doc.content;
}
