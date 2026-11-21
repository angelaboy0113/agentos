import { CloudSheetError, cloudSheetTarget, readCloudSheet } from '../shared/feishu-cloud-sheet.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';

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

export async function readPrdDraft(client, { url, profile, projectId, chatId, questionId, dataDir, readOwnerMembers }) {
  const doc = await readCloudSheet(client, { projectId, originProfile: profile },
    { kind: 'website', projectId, baseUrl: url }, 'read_cloud_document', {}, {
      authorizeDocument: async ({ token, documentType }) => {
        if (documentType !== 'docx') throw new CloudSheetError('PRD_DRAFT_FORMAT', '此链接指向的内容不是飞书在线文档。请贴在线文档链接，或在卡片填入需求初稿。');
        const members = await client.cloudDocumentMembers(token, { profile })
          .catch(error => {
            if (readOwnerMembers && /"code"\s*:\s*1063004\b/.test(error.message)) return readOwnerMembers(token);
            throw error;
          }).catch(() => {
            throw new CloudSheetError('PRD_DRAFT_PERMISSIONS', '助手暂时无法核验文档的共享权限。可以在卡片重新提交链接或贴需求初稿。');
          });
        if (!members.items?.some(({ member_type, member_id, perm }) =>
          member_type === 'openchat' && member_id === chatId && ['view', 'edit', 'full_access'].includes(perm))) {
          throw new CloudSheetError('PRD_DRAFT_SHARE', '请把初稿共享给本群并保留助手的阅读权限，再在卡片中提交链接。也可以直接贴初稿。');
        }
      },
    });
  const title = doc.title || doc.blocks.find(block => block.block_type === 1)?.page?.elements
    ?.map(element => element.text_run?.content ?? '').join('') || '飞书需求初稿';
  const images = doc.blocks.filter(block => block.block_type === 27);
  const attachments = [];
  const previews = new Map();
  for (const { image } of images) {
    const token = image?.token;
    if (!/^[A-Za-z0-9]+$/.test(token ?? '') || previews.has(token) || !client.cloudDocumentImage) continue;
    try {
      const bytes = await client.cloudDocumentImage(token, { profile });
      const attachment = await saveImage(bytes, { questionId, dataDir, profile, projectId, documentToken: doc.documentToken, token });
      attachments.push(attachment);
      previews.set(token, attachment.id);
    } catch {
      previews.set(token, null);
    }
  }
  const imageReferences = images.map((block, index) => ({
    position: index + 1, blockId: block.block_id, attachmentId: previews.get(block.image?.token) ?? null,
  }));
  if (!doc.content?.trim() && !attachments.length) throw new CloudSheetError('PRD_DRAFT_EMPTY', '这份文档没有读到正文或可用图片。请在卡片补充初稿。');
  return { url, title, text: documentTextWithTables(doc), imageCount: images.length, imageReferences, attachments };
}

async function saveImage(bytes, { questionId, dataDir, profile, projectId, documentToken, token }) {
  if (!Buffer.isBuffer(bytes)) throw Error('Cloud image response is not binary');
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw Error('Unsupported cloud image preview');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const binding = createHash('sha256').update(JSON.stringify([questionId, profile, projectId, documentToken, token, sha256])).digest('hex');
  const id = 'ATT-prd-image-' + binding;
  const parent = path.join(dataDir, 'attachments');
  const dir = path.join(parent, createHash('sha256').update(questionId).digest('hex'));
  for (const directory of [parent, dir]) {
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (!(await lstat(directory)).isDirectory()) throw Error('Invalid PRD image directory');
  }
  const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp';
  const file = path.join(dir, id + (png ? '.png' : jpeg ? '.jpg' : '.webp'));
  const tmp = file + '.' + randomUUID();
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  return { id, type: 'image', contentType, path: file,
    source: { kind: 'authorized-prd-document-image', questionId, originProfile: profile, projectId, sha256 } };
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
