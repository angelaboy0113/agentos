// Compatibility renderer for old JSON recipes. Rich/native PPTX generation
// remains available through the task workspace and the bundled design skill.
export async function renderPresentation(spec){
 if(!Array.isArray(spec.slides)||!spec.slides.length)throw Error('PPTX需要slides');
 const {default:PptxGenJS}=await import('pptxgenjs');
 const ppt=new PptxGenJS();ppt.layout='LAYOUT_WIDE';ppt.author='AgentOS';
 const text=v=>{if(typeof v!=='string')throw Error('PPT文字必须为字符串');return v;};
 const color=(key,fallback)=>/^[0-9a-f]{6}$/i.test(spec.theme?.[key]??'')?spec.theme[key]:fallback;
 const accent=color('accent','C54B30'),ink=color('ink','243447'),paper=color('background','FAFAF7');
 const font=typeof spec.theme?.fontFace==='string'?spec.theme.fontFace:'Arial';
 ppt.theme={headFontFace:font,bodyFontFace:font,lang:'zh-CN'};
 const chunks=paragraphs=>{
  const pages=[[]];let weight=0;
  for(const p of paragraphs){text(p);const lines=p.split(/(?<=。|；|\n)/u);let part='';
   for(const line of lines){for(let i=0;i<line.length;i+=240){const next=line.slice(i,i+240);if(part.length+next.length>440){if(part){if(weight+part.length>440){pages.push([]);weight=0;}pages.at(-1).push(part);weight+=part.length;}part='';}part+=next;}}
   if(part){if(weight+part.length>440){pages.push([]);weight=0;}pages.at(-1).push(part);weight+=part.length;}
  }return pages;
 };
 const frame=(title,index,dark=false)=>{
  const s=ppt.addSlide();s.background={color:dark?ink:paper};
  s.addShape(ppt.ShapeType.rect,{x:0,y:0,w:0.16,h:7.5,line:{transparency:100},fill:{color:accent}});
  s.addText(title,{x:0.65,y:0.48,w:12.0,h:0.95,fontFace:font,fontSize:32,bold:true,color:dark?'FFFFFF':ink,margin:0,fit:'shrink'});
  s.addShape(ppt.ShapeType.line,{x:0.65,y:1.62,w:12,h:0,line:{color:dark?'627183':'D8DDD9',width:0.6}});
  s.addText(String(index),{x:11.7,y:7.02,w:0.9,h:0.2,align:'right',fontFace:font,fontSize:10,color:dark?'B8C7D4':'697A85',margin:0});
  return s;
 };
 let page=0;
 for(const [index,s]of spec.slides.entries()){
  const title=text(s.title),paragraphs=(s.paragraphs??[]).map(text),pages=chunks(paragraphs);
  const cover=index===0&&!s.table&&paragraphs.join('').length<=160;
  if(cover){const slide=ppt.addSlide();page++;slide.background={color:ink};
   slide.addShape(ppt.ShapeType.rect,{x:0.7,y:0.85,w:0.75,h:0.1,line:{transparency:100},fill:{color:accent}});
   slide.addText(title,{x:0.7,y:1.55,w:11.8,h:2.2,fontFace:font,fontSize:42,bold:true,color:'FFFFFF',margin:0,fit:'shrink'});
   if(paragraphs.length)slide.addText(paragraphs.join('\n'),{x:0.75,y:4.25,w:10.8,h:1.8,fontFace:font,fontSize:22,color:'D8E1EA',margin:0,breakLine:false,fit:'shrink',valign:'top'});
   continue;
  }
  for(const [pi,body]of pages.entries()){
   if(!body.length&&s.table)continue;
   const slide=frame(title+(pi?'（续）':''),++page);
   if(body.length)slide.addText(body.map((p,i)=>({text:p,options:{breakLine:i<body.length-1,paraSpaceAfter:18}})),{x:0.72,y:2.0,w:11.75,h:4.6,fontFace:font,fontSize:22,color:ink,margin:0,fit:'shrink',valign:'top'});
  }
  if(s.table){
   if(!Array.isArray(s.table)||s.table.some(r=>!Array.isArray(r)))throw Error('PPT表格需要二维字符串数组');
   const slide=frame(title+(paragraphs.length?' · 数据明细':''),++page);
   slide.addTable(s.table.map((r,i)=>r.map(v=>({text:text(v),options:{fill:i===0?ink:i%2?'FFFFFF':'EEF1F0',color:i===0?'FFFFFF':ink,bold:i===0}}))),{x:0.7,y:1.95,w:11.95,h:4.7,fontFace:font,fontSize:16,margin:0.12,border:{color:'DAE0DF',pt:0.5},autoPage:true,autoPageRepeatHeader:true,newSlideStartY:0.65});
  }
 }
 return Buffer.from(await ppt.write({outputType:'nodebuffer',compression:true}));
}
