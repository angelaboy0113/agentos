import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareArtifactWorkspace } from '../shared/artifact-workspace.js';
import { BrowserInputError } from '../shared/browser-tool-input.js';

const run = promisify(execFile);
const maximumPdfBytes = 32 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = detail => new BrowserInputError('BROWSER_ATTACHMENT_UNAVAILABLE', detail);

export async function readWebsitePdfPreview({ dataDir, jobId, target, fetchPdf, authorize }) {
  let directory;
  try {
    if (!await authorize()) throw unavailable('本次附件读取授权已变更。');
    const response = await fetchPdf(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200 || !/^application\/pdf(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || !response.body || Number(response.headers.get('content-length')) > maximumPdfBytes) {
      await response.body?.cancel();
      throw unavailable('附件入口未返回可预览的 PDF（HTTP ' + response.status + '）。原页面仍可调查。');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximumPdfBytes) throw unavailable('此 PDF 超过单文件预览大小，已保留原页面。');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.subarray(0, 5).toString() !== '%PDF-' || !/%%EOF[\x00\s]*$/.test(bytes.subarray(-1024).toString('latin1'))) {
      throw unavailable('附件响应没有通过 PDF 文件检查。');
    }
    if (!await authorize()) throw unavailable('附件读取授权已变更，未保存预览。');
    const workspace = await prepareArtifactWorkspace(dataDir, jobId);
    directory = await mkdtemp(path.join(workspace.directory, 'website-pdf-'));
    const source = path.join(directory, 'source.pdf');
    await writeFile(source, bytes, { mode: 0o600, flag: 'wx' });
    const result = { status: 'verified_pdf', httpStatus: response.status, bytes: size, sha256: sha256(bytes),
      file: path.relative(workspace.directory, source), previewStatus: 'unavailable' };
    const rasterizer = process.env.AGENTOS_PDF_RASTERIZER;
    if (rasterizer && path.isAbsolute(rasterizer)) {
      const prefix = path.join(directory, 'first-page'), page = prefix + '.png';
      try {
        await run(rasterizer, ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1280', '-png', source, prefix],
          { cwd: directory, timeout: 12_000, maxBuffer: 1024 * 1024 });
        const image = await readFile(page);
        if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Invalid page');
        result.previewStatus = 'rendered';
        result.firstPage = { file: path.relative(workspace.directory, page), sha256: sha256(image) };
      } catch {
        await rm(page, { force: true });
        result.previewStatus = 'failed';
      }
    }
    if (!await authorize()) throw unavailable('附件读取授权已变更，未保存预览。');
    return result;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (error instanceof BrowserInputError) throw error;
    throw unavailable('PDF 附件读取或保存未完成，原页面仍可继续调查。');
  }
}
