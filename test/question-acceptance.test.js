import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessInvestigation,investigationComplete} from '../src/shared/investigation-review.js';
import {validateHandoff,enforceHandoff} from '../src/runner/harness.js';
const job={stage:'developer',taskIntent:'analysis',questionScopePolicy:'original-question-v1',originalQuestion:'检查筛选和详情是否正常，仅查看',context:[]};
const report=()=>({outcome:'partial',summary:'发现筛选后空列表异常',finalMessage:'实际查询总数2但列表0行；首页同条件显示2行。详情未提供身份字段，无法对照。未修改数据。',
 investigation:{status:'complete',goals:[{id:'original-question',required:true,status:'verified',evidence:'已逐项实测；筛选失败已对照复核，详情确实未提供字段，结论与限制均有证据。'}],attempts:['实际操作筛选及分页','从首页执行同条件对照','检查详情全部区域'],nextStep:'建议开发修复，本次不自动修改',blocker:null,causalAssessment:null},
 handoff:{artifacts:[{kind:'code',path:'source.js'}],checks:[{id:'original-question',required:true,status:'failed',evidence:'业务检查失败：后页改筛选空列表，详情缺少身份字段'},{id:'filter',required:false,status:'failed',evidence:'总数2，实际0行；首页同条件2行'},{id:'amount',required:false,status:'passed',evidence:'三个样本金额数量均一致'}],risks:['业务异常尚未修复，根因未专项调查'],returnTo:'none'}});
async function workspace(t){const dir=await mkdtemp(path.join(os.tmpdir(),'question-acceptance-'));await writeFile(path.join(dir,'source.js'),'// inspected source');t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const gate=async(t,j,r)=>{const root=await workspace(t),normalized=assessInvestigation(j,r);return {normalized,result:enforceHandoff(normalized,await validateHandoff(j,normalized,root))};};

test('negative business conclusions deliver after both analysis stages without claiming the subject passed',async t=>{
 for(const stage of ['developer','owner_report'])for(const outcome of ['ready','partial','blocked']){
  const r=report();r.outcome=outcome;const {normalized,result}=await gate(t,{...job,stage},r);
  assert.equal(result.outcome,'ready');assert.equal(result.handoffGate.passed,true);assert.equal(investigationComplete({...job,stage},normalized),true);
  assert.equal(normalized.handoff.checks.find(c=>c.id==='original-question').status,'passed');
  const finding=normalized.handoff.checks.find(c=>c.id==='original-question-finding');assert.equal(finding.status,'failed');assert.equal(finding.required,false);assert.equal(finding.evidence,r.handoff.checks[0].evidence);
  assert.equal(normalized.handoff.checks.find(c=>c.id==='filter').status,'failed');assert.match(result.finalMessage,/空列表|列表0行/);assert.deepEqual(normalized.handoff.risks,r.handoff.risks);
  assert.equal(r.handoff.checks[0].status,'failed');
 }
});

test('the rule is generic across database comparisons, configuration audits and web checks',async t=>{
 for(const question of ['核对两个系统的数据是否一致','检查配置是否符合要求','检查网页筛选和分页有没有问题']){
  const {result}=await gate(t,{...job,originalQuestion:question},report());assert.equal(result.outcome,'ready');assert.ok(result.handoff.checks.some(c=>!c.required&&c.status==='failed'));
 }
});

test('normalization is idempotent and preserves colliding finding IDs without dropping evidence',()=>{
 const r=report();r.handoff.checks.push({id:'original-question-finding',required:false,status:'failed',evidence:'another independent finding'});
 const checked=assessInvestigation(job,r);assert.equal(new Set(checked.handoff.checks.map(c=>c.id)).size,checked.handoff.checks.length);assert.ok(checked.handoff.checks.some(c=>c.evidence==='another independent finding'));assert.deepEqual(assessInvestigation(job,checked),checked);
});

test('unexecuted and missing acceptance evidence are never converted to completed findings',async t=>{
 for(const status of ['not_run','not_applicable']){const r=report();r.handoff.checks[0].status=status;const {result}=await gate(t,job,r);assert.equal(result.outcome,'blocked');assert.equal(result.handoffGate.passed,false);}
 const r=report();r.handoff.checks[0].evidence='';const {result}=await gate(t,job,r);assert.equal(result.outcome,'blocked');
});

test('an open question, unavailable tool or absent root evidence cannot close the investigation',()=>{
 for(const kind of ['open','unavailable','missing-evidence']){
  const r=report();if(kind==='missing-evidence')r.investigation.goals[0].evidence='';else r.investigation.goals[0].status='open';
  if(kind==='unavailable'){r.investigation.status='wait';r.investigation.blocker={kind:'unavailable',needed:'browser access',evidence:'no page opened'};r.outcome='blocked';}
  const checked=assessInvestigation(job,r);assert.notEqual(checked.outcome,'ready');assert.notEqual(checked.handoff.checks.find(c=>c.id==='original-question').status,'passed');assert.equal(investigationComplete(job,checked),false);
 }
});

test('causal questions retain cause evidence requirements even when the symptom is reproduced',()=>{
 const r=report();r.investigation.causalAssessment={status:'unknown',link:'unproven',mechanism:'observed empty list',evidence:[{kind:'web_runtime',reference:'query',finding:'empty list'}],alternatives:'cause not known'};
 const checked=assessInvestigation({...job,originalQuestion:'为什么筛选后列表为空？'},r);assert.equal(checked.outcome,'partial');assert.equal(checked.investigation.goals[0].status,'open');assert.equal(checked.handoff.checks[0].status,'failed');
});

test('implementation checks, invalid artifacts and duplicate checks remain blocking',async t=>{
 const implementation=await gate(t,{...job,taskIntent:'implementation'},report());assert.equal(implementation.result.outcome,'blocked');
 const r=report();r.handoff.artifacts[0].path='missing.js';assert.equal((await gate(t,job,r)).result.outcome,'blocked');
 const duplicate=report();duplicate.handoff.checks.push({...duplicate.handoff.checks[0]});assert.equal((await gate(t,job,duplicate)).result.outcome,'blocked');
});
