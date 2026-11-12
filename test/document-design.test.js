import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {documentDesignKinds,documentDesignInstructions} from '../src/shared/document-design.js';
import {renderPresentation} from '../src/shared/presentation-renderer.js';

test('every profile and environment gets format-specific release-bundled design, not ambient skills',async()=>{
 for(const projectId of ['alpha','beta'])for(const sourceEnvironment of ['prd','sit']){
  const plan=await documentDesignInstructions({projectId,sourceEnvironment,originalQuestion:'请做6页PPT及H5文件'});
  assert.deepEqual(plan.receipts.map(x=>x.id),['pptx','frontend-design']);
  assert.match(plan.notice,/pptxgenjs/);assert.match(plan.notice,/responsive|响应式/);
  assert.match(plan.notice,/不增加工具或权限/);assert.match(plan.notice,/独立金额/);
 }
});
test('ordinary database tasks incur no design context and disabled formats stay disabled',async()=>{
 assert.deepEqual(await documentDesignInstructions({originalQuestion:'查询当前订单金额'}),{notice:'',receipts:[]});
 assert.deepEqual(documentDesignKinds({originalQuestion:'不要PPT。请输出H5'}),['html']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'请打开网页查订单'}),[]);
 assert.deepEqual(documentDesignKinds({originalQuestion:'帮我设计网页文件'}),['html']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'不要H5。请制作PPT'}),['pptx']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'做PPT',currentQuestion:'只要文字，不要PPT'}),[]);
});
test('format-free editing reuses bound delivered formats and both formats without cross-job file scans',()=>{
 assert.deepEqual(documentDesignKinds({originalQuestion:'这个文件改漂亮点',attachments:[{contentType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'},{source:{report:{format:'html'}}}]}),['pptx','html']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'修改排版',reportFiles:[{format:'pptx'}]}),['pptx']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'修改为H5，不要PPT',reportFiles:[{format:'pptx'}]}),['html']);
 assert.deepEqual(documentDesignKinds({originalQuestion:'修改排版',attachments:[{path:'/outside/secret'}]}),[]);
});
test('skill provenance manifests include all deployed upstream files and content hashes',async()=>{
 const root=new URL('../config/design-skills/',import.meta.url),manifest=JSON.parse(await readFile(new URL('upstream.json',root)));
 assert.match(manifest.revision,/^[a-f0-9]{40}$/);
 for(const [file,digest] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(new URL(file,root))).digest('hex'),digest,file);
 const plan=await documentDesignInstructions({originalQuestion:'制作PPT'});
 assert.equal(plan.receipts[0].sha256,manifest.files['pptx/SKILL.md']);
});
test('legacy deck now has editorial cover, readable content and separate native table, preserving evidence',async()=>{
 const bytes=await renderPresentation({slides:[{title:'已核实架构',paragraphs:['依据固定源码']},{title:'精确金额',paragraphs:['先说明来源和不同期间'],table:[['编号','金额'],['9007199254740993','1234567890123.45']]}]});
 const zip=await JSZip.loadAsync(bytes),slides=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));
 assert.equal(slides.length,3);
 const cover=await zip.file(slides[0]).async('string');assert.match(cover,/已核实架构/);assert.match(cover,/sz="4200"/);
 const table=await zip.file(slides[2]).async('string');assert.match(table,/<a:tbl>/);assert.match(table,/9007199254740993/);assert.match(table,/1234567890123.45/);
});
test('long old recipes paginate without dropping text or converting null/numbers into false facts',async()=>{
 const paragraphs=Array.from({length:9},(_,i)=>'记录'+i+'：'+('完整内容。'.repeat(35)));
 const bytes=await renderPresentation({slides:[{title:'长文档',paragraphs}]}),zip=await JSZip.loadAsync(bytes);
 const files=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));assert.ok(files.length>1);
 const xml=(await Promise.all(files.map(n=>zip.file(n).async('string')))).join('');
 for(let i=0;i<9;i++)assert.match(xml,new RegExp('记录'+i+'：'));
 await assert.rejects(renderPresentation({slides:[{title:'bad',table:[['金额'],[12.34]]}]}));
});
