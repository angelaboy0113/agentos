import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredNamespaceScope} from '../src/shared/enrollment-namespace-scope.js';
test('trusted namespace selection validates exact live IDs without broadening scope',()=>{
 const available=[{namespace:''},{namespace:'prd'},{namespace:'wl-prd'}];
 assert.deepEqual(configuredNamespaceScope(['wl-prd','wl-prd'],available),['wl-prd']);
 assert.deepEqual(configuredNamespaceScope([''],available),['']);
 assert.equal(configuredNamespaceScope(undefined,available),null);
 for(const invalid of [[],['missing'],['all'],'wl-prd'])assert.throws(()=>configuredNamespaceScope(invalid,available));
});

test('scope selection is pending and owns the live slot, preventing a competing login window',async()=>{
 const {isPendingEnrollment,isLiveEnrollment,sameEnrollmentScope}=await import('../src/shared/enrollment-lifecycle.js');
 assert.equal(isPendingEnrollment({status:'scope_required'}),true);assert.equal(isLiveEnrollment({status:'scope_required'}),true);
 for(const status of ['complete','failed','cancelled','superseded','expired'])assert.equal(isPendingEnrollment({status}),false);
 const scope={projectId:'p',chatId:'g',profile:'a',questionId:'q'};assert.equal(sameEnrollmentScope(scope,{...scope}),true);
 for(const key of Object.keys(scope))assert.equal(sameEnrollmentScope(scope,{...scope,[key]:'other'}),false);
});
