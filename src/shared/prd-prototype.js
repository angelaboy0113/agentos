import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readPrdDesignReference, generateNativeImage } from './image-generation.js';
import { currentUserQuestion } from './user-request-scope.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function layoutError(message) {
  return Object.assign(new Error(message), { code: 'IMAGE_PROMPT' });
}

export async function producePrdPrototype(dataDir, job, content, options) {
  const reference = await readPrdDesignReference(dataDir, job);
  if (!reference) throw Object.assign(new Error('请先截取当前轮真实目标或同系统参考页面'), { code: 'IMAGE_LIVE_SCREEN_REQUIRED' });
  let spec;
  try { spec = JSON.parse(content); }
  catch { throw layoutError('PRD 原型须提供截图上的改动区域，或新页面的参考设计描述'); }
  const existing = spec?.mode === 'existing-page';
  if (!existing && (spec?.mode !== 'new-page' || typeof spec.prompt !== 'string' || !spec.prompt.trim())) {
    throw layoutError('请选择 existing-page 或 new-page 并给出对应内容');
  }
  const areas = existing ? spec.areas : [];
  if (!Array.isArray(areas) || existing && (!areas.length || areas.some(a =>
    !a || ![a.x,a.y,a.width,a.height].every(n => typeof n === 'number' && Number.isFinite(n))
    || a.x < 0 || a.y < 0 || a.width <= 0 || a.height <= 0 || a.x+a.width > 1 || a.y+a.height > 1
    || typeof a.text !== 'string' || !a.text.trim()
  ) || areas.reduce((sum,a) => sum+a.width*a.height,0) >= 0.75)) {
    throw layoutError('改动区需要在实际截图内填写 x、y、width、height（0 到 1）和拟新增的界面文案');
  }
  const base = await readFile(reference.path);
  if (hash(base) !== reference.sha256) throw layoutError('截图已变化，请重新捕获');
  const proposed = existing ? null : await generateNativeImage(dataDir, job, spec.prompt, options);
  const encode = bytes => 'data:image/png;base64,' + bytes.toString('base64');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let bytes;
  try {
    const context = await browser.newContext({ acceptDownloads: false });
    await context.route('**/*', r => r.abort());
    const page = await context.newPage();
    const output = await page.evaluate(async ({ original, proposal, areas }) => {
      async function load(src) {
        const picture = new Image();
        picture.src = src;
        await picture.decode();
        return picture;
      }
      const source = await load(original);
      const design = proposal ? await load(proposal) : null;
      const canvas = document.createElement('canvas');
      const w = source.naturalWidth, h = source.naturalHeight;
      const header = design ? 32 : 0, gap = design ? 16 : 0;
      canvas.width = design ? w*2+gap : w;
      canvas.height = h+header;
      const ctx = canvas.getContext('2d');
      if (design) {
        ctx.fillStyle = '#f4f5f7';
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.font = '16px sans-serif';
        ctx.fillStyle = '#252b35';
        ctx.fillText('同环境参考页面 · 脱敏现场截图',8,21);
        ctx.fillText('新页面 · 拟议设计',w+gap+8,21);
        const scale = Math.min(w/design.naturalWidth, h/design.naturalHeight);
        ctx.drawImage(design,w+gap,header,design.naturalWidth*scale,design.naturalHeight*scale);
      }
      ctx.drawImage(source,0,header);
      areas.forEach((area,index) => {
        const x = Math.round(area.x*w), y = Math.round(area.y*h);
        const width = Math.min(w-x,Math.round(area.width*w)), height = Math.min(h-y,Math.round(area.height*h));
        if (width < 14 || height < 14) throw Error('标注区域太小');
        ctx.fillStyle = '#fffbe5';
        ctx.fillRect(x,y,width,height);
        ctx.strokeStyle = '#c49a22';
        ctx.strokeRect(x+0.5,y+0.5,width-1,height-1);
        ctx.fillStyle = '#252b35';
        ctx.font = Math.min(15,height-6)+'px sans-serif';
        const label = (areas.length > 1 ? String(index+1)+'. ' : '① ') + area.text;
        if (ctx.measureText(label).width > width-10) throw Error('标注文字超出改动区域');
        ctx.fillText(label,x+5,y+height/2+5);
      });
      return canvas.toDataURL().split(',')[1];
    }, { original:encode(base), proposal:proposed && encode(proposed.bytes), areas });
    bytes = Buffer.from(output,'base64');
  } catch (error) {
    if (/标注区域太小|标注文字超出/.test(error.message)) throw layoutError('请调整截图上的局部改动区域或缩短标注文案');
    throw error;
  } finally {
    await browser.close();
  }
  return { bytes, provenance: { status:'verified', provider:'prd-screenshot-composite', mode:spec.mode,
    sha256:hash(bytes), inputHashes:[reference.sha256], referenceKinds:[reference.kind],
    binding:{ jobId:job.id, questionId:job.questionId, projectId:job.projectId,
      profile:job.originProfile??job.agentProfile, environment:job.sourceEnvironment,
      generation:job.questionGeneration??job.prd.revision, questionHash:hash(String(currentUserQuestion(job))) },
    ...(proposed ? { proposedImage:proposed.provenance } : {}) } };
}
