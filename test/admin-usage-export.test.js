import test from 'node:test';import assert from 'node:assert/strict';import ExcelJS from 'exceljs';
import {adminUsage} from '../src/control-plane/admin-usage.js';import {usageWorkbook} from '../src/control-plane/admin-usage-export.js';
const turn=(id,extra={})=>({id,messageId:'m-'+id,profile:'a',chatId:'g',senderId:'u',createdAt:'2026-11-06T16:00:00Z',content:'查询销售',status:'sent',...extra});
test('each business question or followup earns one even when blocked; chatter and environment do not',()=>{
 const t=turn('1'),s={conversations:[t,{...t},turn('2',{parentId:'root',status:'failed'}),turn('3',{content:'谢谢'}),turn('4',{content:'prd'}),turn('5',{content:''})]};const u=adminUsage(s,{scope:'all'});
 assert.equal(u.summary.points,2);assert.equal(u.ranking[0].points,2);assert.equal(u.records.find(r=>r.id==='2').points,1);assert.equal(u.records.find(r=>r.id==='3').points,0);assert.equal(u.records.find(r=>r.id==='5').points,0);assert.equal(adminUsage(s).summary.points,2);
});
test('points respect administrator, person, assistant and date filters',()=>{
 const s={conversations:[turn('1'),turn('2',{senderId:'owner'}),turn('3',{profile:'b',senderId:'v',createdAt:'2026-11-05T00:00:00Z'})]},opts={projects:{ownerOpenIdsByProfile:{a:['owner']}}};assert.equal(adminUsage(s,{},opts).summary.points,2);assert.equal(adminUsage(s,{profile:'a',start:'2026-11-07'},opts).summary.points,1);assert.equal(adminUsage(s,{excludeAdmin:'false'},opts).summary.points,3);
});
test('actual xlsx exports all pages, numeric points, full text and safe literal formulas',async()=>{
 const text='=HYPERLINK("https://example.invalid","x") '+ '查询'.repeat(20000),s={conversations:Array.from({length:65},(_,i)=>turn(String(i),{content:i===0?text:'查询'+i}))},u=adminUsage(s,{}, {allRecords:true});assert.equal(u.records.length,65);const buffer=await usageWorkbook(u).xlsx.writeBuffer();assert.equal(buffer.subarray(0,2).toString(),'PK');const restored=new ExcelJS.Workbook();await restored.xlsx.load(buffer);
 assert.deepEqual(restored.worksheets.map(s=>s.name),['积分榜','提问明细','统计口径']);const rank=restored.getWorksheet('积分榜');assert.equal(rank.getCell('C2').value,65);assert.equal(typeof rank.getCell('C2').value,'number');const d=restored.getWorksheet('提问明细');assert.equal(d.rowCount,66);assert.equal(d.getCell('F2').type,ExcelJS.ValueType.String);assert.equal(d.getCell('F2').value+d.getCell('L2').value,text);assert.equal(d.getCell('H2').value,1);assert.equal(d.getCell('H2').type,ExcelJS.ValueType.Number);
});
test('person export retains filters and only selected person without changing global ranking',async()=>{
 const s={conversations:[turn('1'),turn('2',{senderId:'v'})]},first=adminUsage(s).ranking[0].key,u=adminUsage(s,{person:first,start:'2026-11-07'}, {allRecords:true});const book=usageWorkbook(u,{person:first});assert.equal(book.getWorksheet('积分榜').rowCount,2);assert.equal(book.getWorksheet('提问明细').rowCount,2);assert.ok(book.getWorksheet('统计口径').getSheetValues().some(r=>r?.[1]==='开始日期'&&r[2]==='2026-11-07'));
});
test('empty xlsx remains a valid workbook with zero points and column headers',async()=>{
 const book=usageWorkbook(adminUsage({}));const restored=new ExcelJS.Workbook();await restored.xlsx.load(await book.xlsx.writeBuffer());assert.equal(restored.getWorksheet('积分榜').rowCount,1);assert.equal(restored.getWorksheet('提问明细').rowCount,1);
});
