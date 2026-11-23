import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readPrdDesignReference, generateNativeImage } from './image-generation.js';
import { currentUserQuestion } from './user-request-scope.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const prdPrototypeKey = /^[a-z][a-z0-9-]{0,63}$/;
function layoutError(message) {
  return Object.assign(new Error(message), { code: 'IMAGE_PROMPT' });
}

export async function producePrdPrototype(dataDir, job, content, options = {}) {
  let spec;
  try { spec = JSON.parse(content); }
  catch { throw layoutError('PRD 原型须提供截图上的改动区域，或新页面的参考设计描述'); }
  const inline = job.prd.inlinePrototypes === true;
  const nativeEdit = inline && job.prd.nativePrototypeEdits === true;
  if (inline && !prdPrototypeKey.test(spec?.prototypeKey ?? '')) throw layoutError('每张原型须填写对应正文的 prototypeKey');
  const reference = await readPrdDesignReference(dataDir, job, spec?.referenceId);
  if (!reference) throw Object.assign(new Error('请先截取当前轮真实目标或同系统参考页面'), { code: 'IMAGE_LIVE_SCREEN_REQUIRED' });
  const base = await readFile(reference.path);
  if (hash(base) !== reference.sha256) throw layoutError('截图已变化，请重新捕获');
  const provenance = {
    status:'verified', mode:spec.mode,
    ...(inline ? { prototypeKey:spec.prototypeKey, referenceId:spec.referenceId } : {}),
    inputHashes:[reference.sha256], referenceKinds:[reference.kind],
    binding:{ jobId:job.id, questionId:job.questionId, projectId:job.projectId,
      profile:job.originProfile??job.agentProfile, environment:job.sourceEnvironment,
      generation:job.questionGeneration??job.prd.revision, questionHash:hash(String(currentUserQuestion(job))) }
  };
  if (inline && spec.mode === 'reference-only') {
    if (Object.keys(spec).some(key=>!['mode','prototypeKey','referenceId'].includes(key)))
      throw layoutError('原样引用现场截图时只填写 mode、prototypeKey 和 referenceId');
    return {bytes:base, provenance:{...provenance,provider:'prd-live-screenshot',sha256:reference.sha256}};
  }
  const existing = spec?.mode === 'existing-page';
  const composite = inline || existing;
  if ((!existing && spec?.mode !== 'new-page') ||
      ((nativeEdit || !composite) && (typeof spec.prompt !== 'string' || !spec.prompt.trim()))) {
    throw layoutError('请选择 existing-page 或 new-page 并给出对应内容');
  }
  const areas = composite ? spec.areas : [];
  const shifts = inline && !nativeEdit ? spec.shifts ?? [] : [];
  const withinScreenshot = a => a && [a.x,a.y,a.width,a.height].every(n => typeof n === 'number' && Number.isFinite(n))
    && a.x >= 0 && a.y >= 0 && a.width > 0 && a.height > 0 && a.x+a.width <= 1 && a.y+a.height <= 1;
  if (!Array.isArray(shifts) || shifts.some(s=>!withinScreenshot(s)||typeof s.dy!=='number'||s.dy<=0||s.dy>=s.height)
    || !Array.isArray(areas) || composite && (!areas.length || areas.some(a =>
    !withinScreenshot(a) || (inline && !nativeEdit && !withinScreenshot(a.sample))
    || (a.inset!==undefined&&(!Number.isFinite(a.inset)||a.inset<0||a.inset>=1))
    || ((!inline || a.text !== undefined) && (typeof a.text !== 'string' || !a.text.trim() || /[\r\n]/.test(a.text)))
  ) || !inline && areas.reduce((sum,a) => sum+a.width*a.height,0) >= 0.75)) {
    throw layoutError('改动区需要在实际截图内填写 x、y、width、height（0 到 1）和拟新增的界面文案');
  }
  const visibleRegions = areas.map(({x,y,width,height})=>({x,y,width,height}));
  const firstEdit = nativeEdit ? [
    'Edit the attached real UI screenshot in place. Preserve its aspect ratio, viewport framing, branding and layout outside the edit rectangles.',
    'Inside the edit rectangles preserve all unchanged components, exact labels, alignment, colors, row heights, button styles and layout seen in the screenshot.',
    'Reuse the visible reference controls for new fields, rows or actions. Keep visible workflow states and existing terminology. Leave masked fields and records masked; do not reconstruct them.',
    'If the requirement calls for a new page, adapt the reference page structure in the rectangles rather than redesigning the application shell.',
    'Return one full edited screenshot with no margins, captions, split panels, or annotations. The allowed rectangles use x, y, width and height as fractions of the screenshot.',
    JSON.stringify(visibleRegions),
    spec.prompt,
  ].join('\n') : spec.prompt;
  const proposed = !composite || nativeEdit ? await generateNativeImage(dataDir, job, firstEdit,
    {...options,referenceId:spec.referenceId,editReference:nativeEdit}) : null;
  const encode = bytes => 'data:image/png;base64,' + bytes.toString('base64');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let bytes;
  try {
    const context = await browser.newContext({ acceptDownloads: false });
    await context.route('**/*', r => r.abort());
    const page = await context.newPage();
    const output = await page.evaluate(async ({ original, proposal, areas, shifts, nativeEdit, brandRegions }) => {
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
      if (nativeEdit) {
        if (Math.abs(design.naturalWidth/design.naturalHeight/(w/h)-1)>0.03) throw Error(`生图比例与底图不一致（${design.naturalWidth}×${design.naturalHeight}，底图 ${w}×${h}）`);
        canvas.width=w;
        canvas.height=h;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(source,0,0);
        ctx.beginPath();
        for(const {x,y,width,height} of areas){
          const left=Math.round(x*w),top=Math.round(y*h),right=Math.round((x+width)*w),bottom=Math.round((y+height)*h);
          ctx.rect(left,top,right-left,bottom-top);
        }
        ctx.save();
        ctx.clip();
        ctx.drawImage(design,0,0,w,h);
        ctx.restore();
        for(const {x,y,width,height} of brandRegions){
          const left=Math.floor(x*w),top=Math.floor(y*h),widthPx=Math.ceil((x+width)*w)-left,heightPx=Math.ceil((y+height)*h)-top;
          ctx.drawImage(source,left,top,widthPx,heightPx,left,top,widthPx,heightPx);
        }
        return canvas.toDataURL().split(',')[1];
      }
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
      // Copy only the scrollable remainder of the existing menu. The new
      // row is painted separately in the slot opened by this shift.
      for (const shift of shifts) {
        const x=Math.round(shift.x*w), y=Math.round(shift.y*h), width=Math.round(shift.width*w);
        const dy=Math.round(shift.dy*h), height=Math.round(shift.height*h)-dy;
        if(dy<1||height<1)throw Error('菜单顺移区域太小');
        ctx.drawImage(source,x,y,width,height,x,y+dy,width,height);
      }
      areas.forEach((area,index) => {
        const x = Math.round(area.x*w), y = Math.round(area.y*h);
        const width = Math.min(w-x,Math.round(area.width*w)), height = Math.min(h-y,Math.round(area.height*h));
        if (width < 1 || height < 1) throw Error(`第 ${index+1} 个改动区没有可用像素`);
        if (area.sample) {
          const sx = Math.round(area.sample.x*w), sy = Math.round(area.sample.y*h);
          const sw = Math.round(area.sample.width*w), sh = Math.round(area.sample.height*h);
          if (sw < 1 || sh < 1) throw Error(`第 ${index+1} 个取样区没有可用像素`);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x,y,width,height);
          ctx.clip();
          ctx.drawImage(source,sx,sy,sw,sh,x,y,width,height);
          if (area.text) {
            const inset = area.inset===undefined?Math.max(5,Math.min(12,Math.round(width*0.08))):Math.round(width*area.inset);
            const fontSize = Math.min(parseFloat(area.sample.fontSize) || 14, height - 2);
            const edgeWidth = Math.max(1, Math.round(sw * 0.04));
            const font = area.sample.fontFamily || 'system-ui, sans-serif';
            ctx.font = fontSize+'px '+font;
            const available=width-inset-3;
            const fitted=Math.min(fontSize,Math.floor(fontSize*available/ctx.measureText(area.text).width));
            if(fitted<9)throw Error(`第 ${index+1} 个改动区文字放不下：宽 ${width}px、高 ${height}px，请扩大区域或缩短文字`);
            ctx.font=fitted+'px '+font;
            // Extend the sampled control background across its label slot.
            const sourceTop=Math.min(3,Math.floor((sh-1)/2)),targetTop=Math.min(3,Math.floor((height-1)/2));
            ctx.drawImage(source,sx+Math.max(0,sw-edgeWidth-2),sy+sourceTop,edgeWidth,sh-2*sourceTop,
              x+2,y+targetTop,width-4,height-2*targetTop);
            ctx.fillStyle = area.sample.color || '#303133';
            ctx.textBaseline = 'middle';
            ctx.fillText(area.text,x+inset,y+height/2);
          }
          ctx.restore();
          return;
        }
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
    }, { original:encode(base), proposal:proposed && encode(proposed.bytes), areas, shifts, nativeEdit,
      brandRegions:(reference.brandRegions??[]).filter(withinScreenshot) });
    bytes = Buffer.from(output,'base64');
  } catch (error) {
    const detail=error.message.match(/(?:生图比例与底图不一致[^\r\n]*|菜单顺移区域太小|第 \d+ 个[^\r\n]+|标注文字超出改动区域)/)?.[0];
    if (detail) throw layoutError(`原型「${spec.prototypeKey??spec.mode}」：${detail}`);
    throw error;
  } finally {
    await browser.close();
  }
  return { bytes, provenance: { ...provenance, provider:nativeEdit?'prd-native-image-edit':'prd-screenshot-composite',sha256:hash(bytes),
    ...(proposed ? { proposedImage:proposed.provenance } : {}) } };
}
