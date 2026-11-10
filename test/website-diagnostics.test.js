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
