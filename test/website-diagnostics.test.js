import test from 'node:test';import assert from 'node:assert/strict';
import {pageDiagnostic,websiteDiagnostics} from '../src/shared/website-diagnostics.js';
import {validateBrowserTool} from '../src/shared/browser-tool-input.js';
import {websiteTools} from '../src/runner/environment-job.js';
const state=()=>({environment:{baseUrl:'https://app.example/'},page:{url:()=> 'https://app.example/app?token=never-return'},blockedResources:new Set(),resourceFailures:new Set(),pageErrors:new Set(),pendingReads:new Set()});
test('runtime and network diagnostics disclose structured metadata, never console payloads or credentials',()=>{
 const s=state();pageDiagnostic(s,{name:'TypeError',message:"Cannot read properties of undefined (reading 'rows') token=raw-secret",source:'https://app.example/app.js?token=secret',line:10});pageDiagnostic(s,{kind:'response',source:'https://app.example/api/items?password=secret',method:'GET',status:401});pageDiagnostic(s,{name:'TypeError',message:"Cannot read properties of undefined (reading 'password')",source:'https://secret:password@app.example/app.js'});
 const r=websiteDiagnostics(s);assert.equal(r.recent[0].undefinedProperty,'rows');assert.equal(r.recent[1].status,401);assert.equal(r.recent[2].undefinedProperty,undefined);assert.equal(r.recent[2].path,undefined);assert.doesNotMatch(JSON.stringify(r),/token|password|secret|raw-/);
 for(let i=0;i<90;i++)pageDiagnostic(s,{kind:'response',status:200});assert.equal(s.readDiagnostics.length,64);
});
test('diagnostic and hover tools are exposed with fixed arguments only',()=>{
 for(const tool of ['browser_diagnostics','browser_hover'])assert.ok(websiteTools({environmentAccess:{}},{}).spec.some(x=>x.tool===tool));
 validateBrowserTool('browser_diagnostics',{});validateBrowserTool('browser_hover',{ref:'current'});
 assert.throws(()=>validateBrowserTool('browser_diagnostics',{url:'https://other.example'}));assert.throws(()=>validateBrowserTool('browser_hover',{selector:'body'}));
});
test('pending reads expose timing and scoped paths, distinguishing query action from background polls',()=>{
 const s=state();s.pendingReadMetadata=new WeakMap();
 const req=(url)=>({url:()=>url,method:()=> 'POST'});
 const a=req('https://app.example/api/history?token=secret'),b=req('https://app.example/poll'),c=req('https://other.example/private');
 for(const [r,q]of [[a,true],[b,false],[c,true]]){s.pendingReads.add(r);s.pendingReadMetadata.set(r,{startedAt:Date.now()-5000,queryInitiated:q});}
 const d=websiteDiagnostics(s);assert.equal(d.pendingQueries,1);assert.equal(d.pendingReadDetails.length,2);assert.ok(d.pendingReadDetails[0].elapsedMs>=5000);assert.equal(d.pendingReadDetails[0].path,'/api/history');assert.doesNotMatch(JSON.stringify(d),/secret|token|other\.example/);
 s.pendingReads.delete(a);assert.equal(websiteDiagnostics(s).pendingQueries,0);
});
test('action diagnostics distinguish an earlier auxiliary denial from current query observations',async()=>{
 const {websiteActionDiagnostics}=await import('../src/shared/website-diagnostics.js');const s=state(),now=new Date().toISOString(),old='2026-01-01T00:00:00.000Z';
 s.blockedRequestDetails=[{at:old,path:'/auxiliary'}];s.readDiagnostics=[{at:old,kind:'runtime',name:'TypeError'},{at:now,kind:'request',path:'/api/query',method:'GET'}];
 const r=websiteActionDiagnostics(s,{tool:'browser_click',controlKind:'query',controlLabel:'开始查询',startedAt:now});assert.deepEqual(r.blockedDuringAction,[]);assert.equal(r.requestsObservedDuringAction.length,1);assert.equal(r.recent.length,0);assert.equal(r.controlKind,'query');
 s.blockedRequestDetails.push({at:now,path:'/api/query'});assert.equal(websiteActionDiagnostics(s,{startedAt:now}).blockedDuringAction.length,1);
});
