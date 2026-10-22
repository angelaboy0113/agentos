import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {groupedDatasetStatement} from '../src/runner/environment-tools.js';import {ReportDatasets} from '../src/runner/report-datasets.js';
test('keyset pagination is inferred only from verified unique primary keys and fixed join semantics',()=>{
 const tables=new Map([['orders',['ID','SUBMIT_TIME']],['items',['ID','ORDER_ID','NAME']]]),types=new Map(),q={tables:['*'],maxRows:20},keys=new Map([['orders',['ID']],['items',['ID']]]);
 const args={leftTable:'orders',rightTable:'items',join:{leftColumn:'ID',rightColumn:'ORDER_ID'},groupColumns:['ID','ORDER_ID','NAME'].map(column=>({table:'items',column})),aggregates:[{op:'count',table:'items',column:'ID',as:'records'}],filters:[{table:'orders',column:'SUBMIT_TIME',op:'>=',value:'2026-01-01'}]};
 const s=groupedDatasetStatement(args,tables,types,q,new Map(),keys);assert.deepEqual(s.cursor.columns,['ORDER_ID','ID']);assert.match(s.sql,/ORDER BY `r`.`ORDER_ID`, `r`.`ID`/);assert.doesNotMatch(s.sql,/GROUP BY/);assert.match(s.sql,/1 AS `records`/);
 assert.equal(groupedDatasetStatement({...args,join:{...args.join,type:'left'}},tables,types,q,new Map(),keys).cursor,undefined);
 assert.equal(groupedDatasetStatement(args,tables,types,q,new Map(),new Map([['items',['ID','ORDER_ID']]])).cursor,undefined);
 const mixed={...args,groupColumns:[{table:'items',column:'ID'},{table:'orders',column:'SUBMIT_TIME'}]};assert.equal(groupedDatasetStatement(mixed,tables,types,q,new Map(),keys).cursor,undefined);
});
test('keyset exports bind composite cursor parameters, advance without OFFSET and retain exact scope and coverage',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'keyset-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const rows=Array.from({length:80037},(_,i)=>({ORDER_ID:String(Math.floor(i/24)).padStart(6,'0'),ID:String(i).padStart(8,'0'),amount:'0.10'}));
 const d=new ReportDatasets({maxRows:'all',directory:dir,scope:'keyset'});let calls=0;
 const statement={sql:'SELECT ORDER_ID,ID,amount FROM items WHERE created>=? GROUP BY ORDER_ID,ID,amount ORDER BY ORDER_ID,ID',params:['fixed-start'],columns:['ORDER_ID','ID','amount'],cursor:{columns:['ORDER_ID','ID'],expressions:['ORDER_ID','ID']},batchSize:50};
 const result=await d.collect(statement,async({sql},params)=>{calls++;assert.doesNotMatch(sql,/OFFSET/);assert.equal(params[0],'fixed-start');const limit=Number(sql.match(/LIMIT (\d+)$/)[1]);let start=0;if(params.length>1){assert.match(sql,/ORDER_ID > \?\) OR \(ORDER_ID = \? AND ID > \?/);start=Number(params.at(-1))+1;}return [rows.slice(start,start+limit)];});
 assert.equal(result.complete,true);assert.equal(result.rowCount,80037);assert.ok(calls<20);const saved=await d.restore(result.datasetRef);assert.equal(saved.rows[80036].ID,'00080036');assert.equal(new Set(saved.rows.map(r=>r.ID)).size,80037);
});
