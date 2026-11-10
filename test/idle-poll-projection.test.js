import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JsonStore} from '../src/shared/store.js';
import {pollModelCapacity} from '../src/control-plane/model-capacity-recovery.js';
import {WebsiteEvidenceDelivery} from '../src/control-plane/website-evidence.js';

test('idle recovery and screenshot polling do not clone unrelated task histories',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'idle-projection-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new JsonStore(path.join(dir,'state.json'));
 await store.transact(s=>{s.jobs=[{id:'other',status:'completed',events:Array.from({length:20000},(_,i)=>({at:i,message:'Synthetic retained history'}))}];s.websiteEvidenceDeliveries={sent:{messageId:'sent'},paused:{retryAt:Date.now()+60000},obsolete:{superseded:true}};});
 const before={...store.readMetrics};const context={store,feishu:{replyImage(){throw Error('idle poll must not send');}}};
 await Promise.all([pollModelCapacity(context),new WebsiteEvidenceDelivery(context).retry()]);
 assert.equal(store.readMetrics.full,before.full);assert.equal(store.readMetrics.selected-before.selected,2);
 assert.equal((await store.select(s=>s.jobs[0].events.length)),20000);
});
