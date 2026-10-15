import test from 'node:test';
import assert from 'node:assert/strict';
import {recordReportFiles,recordReportReview,assessReportDelivery,acceptedReportResult,reportEligible} from '../src/shared/report-acceptance.js';
import {interruptedInvestigation} from '../src/shared/investigation-budget.js';
const file={id:'report-a',verificationHash:'a'.repeat(64),questionGeneration:1};
function fixture(){const job={taskIntent:'analysis',stage:'developer',originalQuestion:'导出所有客户库存清单',reportFiles:[]};recordReportFiles(job,[file],1);return job;}
function review(issues=[]){return {outcome:'needs_clarification',summary:'库存清单已核验',finalMessage:'全量文件；历史快照差异仅作参考。',handoffGate:{passed:true},reportAssessment:{fileId:'report-a',coverage:'complete',decision:'deliver',issues},investigation:{status:'continue',goals:[{id:'original-question',required:true,status:'open',evidence:'全量文件已核对'}]},environmentQuery:{purpose:'追查历史差异'}};}
test('structural receipt alone is never semantic acceptance',()=>{const job=fixture();assert.equal(reportEligible(job,file),false);assert.equal(acceptedReportResult(job),null);assert.equal(assessReportDelivery(job,{outcome:'ready'}).outcome,'partial');});
test('explicit completed review delivers despite optional history differences and cancels extra investigation',()=>{
 const job=fixture(),r=assessReportDelivery(job,review([{kind:'historical_difference',evidence:'另一个取数时间金额不同'}]));assert.equal(r.outcome,'ready');assert.equal(r.environmentQuery,null);
 recordReportReview(job,{...r,handoffGate:{passed:true}});assert.equal(reportEligible(job,file),true);assert.equal(interruptedInvestigation(job,'time limit').outcome,'ready');
});
test('material current defects invalidate a prior accepted version, history alone cannot',()=>{
 const job=fixture();recordReportReview(job,assessReportDelivery(job,review()));
 recordReportReview(job,{...review([{kind:'historical_difference',evidence:'old total'}]),reportAssessment:{...review().reportAssessment,decision:'revise',issues:[{kind:'historical_difference',evidence:'old total'}]}});assert.ok(acceptedReportResult(job));
 recordReportReview(job,{...review(),reportAssessment:{fileId:'report-a',coverage:'incomplete',decision:'revise',issues:[{kind:'current_scope',evidence:'本轮筛选缺少用户要求的有效状态'}]}});assert.equal(reportEligible(job,file),false);assert.equal(acceptedReportResult(job),null);
});
test('unknown file, failed handoff and original reconciliation requirements cannot silently become deliverable',()=>{
 const job=fixture();recordReportReview(job,{...review(),handoffGate:{passed:false}});assert.equal(acceptedReportResult(job),null);
 recordReportReview(job,{...review(),reportAssessment:{...review().reportAssessment,fileId:'foreign'}});assert.equal(acceptedReportResult(job),null);
 const r=assessReportDelivery(job,review([{kind:'required_output',evidence:'用户还要求解释历史差额，尚未完成'}]));assert.notEqual(r.outcome,'ready');
});
test('history-only revision cannot expand a completed export request; causal questions still require causal proof',async()=>{
 const job=fixture(),r=review([{kind:'historical_difference',evidence:'昨天另一个快照金额不同'}]);r.reportAssessment.decision='revise';
 assert.equal(assessReportDelivery(job,r).outcome,'ready');
 const {assessInvestigation}=await import('../src/shared/investigation-review.js');const causal=assessInvestigation({...job,originalQuestion:'导出清单并解释为什么金额变化'},r);assert.notEqual(causal.investigation.status,'complete');assert.equal(causal.outcome,'partial');
});
test('unreviewed files cannot become ready just by an old original-question flag',async()=>{
 const {assessInvestigation}=await import('../src/shared/investigation-review.js');const job=fixture();const r=review();delete r.reportAssessment;r.outcome='ready';r.investigation.goals[0].status='verified';assert.equal(assessInvestigation(job,r).outcome,'partial');
});
test('review state and accepted version survive JSON persistence, no receipt means no delivery',()=>{
 const job=fixture();recordReportReview(job,assessReportDelivery(job,review()));const restarted=JSON.parse(JSON.stringify(job));assert.equal(acceptedReportResult(restarted).outcome,'ready');
 recordReportFiles(restarted,[{id:'draft'}],1);assert.equal(reportEligible(restarted,{id:'draft'}),false);
});
test('store completion persists accepted review and runner stops before optional environment queries',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {JsonStore}=await import('../src/shared/store.js');const {AgentRunner}=await import('../src/runner/index.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'report-review-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const job={...fixture(),id:'job',workflow:'single_developer',status:'running',continuousInvestigation:true,context:[],events:[],lease:{id:'lease',runnerId:'runner',expiresAt:new Date(Date.now()+60000).toISOString()}};
 const r=assessReportDelivery(job,review([{kind:'historical_difference',evidence:'历史取数不同'}]));const runner=new AgentRunner({},async()=>r);runner.post=async()=>assert.fail('completed report must not open another query');assert.equal((await runner.executeContinuous(job,async()=>{},new AbortController().signal)).outcome,'ready');
 const store=new JsonStore(path.join(root,'state.json'));await store.transact(s=>{s.jobs.push(job);});await store.appendEvent('job',{type:'completed',runnerId:'runner',leaseId:'lease',result:r});
 const restarted=new JsonStore(path.join(root,'state.json')),saved=await restarted.getJob('job');assert.equal(saved.reportReviews['report-a'].status,'accepted');assert.equal(saved.status,'completed');
});
test('accepted state requires original-question closure as well as an explicit delivery review',()=>{
 const job=fixture(),r=assessReportDelivery(job,review());r.investigation.goals[0].status='open';recordReportReview(job,r);assert.equal(acceptedReportResult(job),null);
});
test('an unavailable or wrong-version inspection cannot be promoted by an old verified goal',async()=>{
 const {assessInvestigation}=await import('../src/shared/investigation-review.js');const job=fixture();job.reportEvidence={status:'unavailable',binding:{fileId:file.id}};const r=review();r.investigation.goals[0].status='verified';assert.equal(assessInvestigation(job,r).outcome,'partial');
});

test('a narrower population cannot pass without reviewing the bound scope differences',()=>{
 const job=fixture();job.reportEvidence={status:'verified',binding:{fileId:file.id,verificationHash:file.verificationHash},calculationAudit:{status:'passed'},populationAudit:{selected:{datasetRef:'population'},comparisons:[{datasetRef:'all-customers',keyColumn:'id',onlyReferenceCount:3,onlyFileCount:0}]}};
 const r=review();r.outcome='ready';assert.equal(assessReportDelivery(job,r).outcome,'partial');
 r.reportAssessment.scopeReview={populationRef:'population',evidence:'用户明确只要有交易的客户',comparisons:[{datasetRef:'all-customers',keyColumn:'id',decision:'covered',evidence:'all'}]};assert.equal(assessReportDelivery(job,r).outcome,'partial');
 r.reportAssessment.scopeReview.comparisons[0]={datasetRef:'all-customers',keyColumn:'id',decision:'out_of_scope',evidence:'原问题限定有交易客户，另3户无交易，按已核实业务规则排除'};assert.equal(assessReportDelivery(job,r).outcome,'ready');
});
