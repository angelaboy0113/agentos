import test from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {KnowledgeSource} from '../src/control-plane/knowledge-source.js';
const exec=promisify(execFile);const git=async(dir,...args)=>(await exec('git',['-c','core.hooksPath='+os.devNull,'-C',dir,...args],{env:{...process.env,GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'user.name',GIT_CONFIG_VALUE_0:'Test',GIT_CONFIG_KEY_1:'user.email',GIT_CONFIG_VALUE_1:'test@example.invalid'}})).stdout.trim();
test('environment branch proof ignores personal checkout changes but detects an actual configured branch advance',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'knowledge-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),remote=path.join(dir,'remote.git');await mkdir(repo);await mkdir(remote);await git(remote,'init','--bare');await git(repo,'init','-b','prd');
 await writeFile(path.join(repo,'route.js'),'PRD');await git(repo,'add','.');await git(repo,'commit','-m','prd');await git(repo,'remote','add','origin',remote);await git(repo,'push','origin','prd');
 const commit=await git(repo,'rev-parse','HEAD');await git(repo,'checkout','-b','personal');await writeFile(path.join(repo,'route.js'),'personal changes');
 const project={repoPath:dir,analysisSourceMode:'isolated',analysisEnvironments:{prd:{repositories:[{path:'repo',branch:'prd'}]},uat:{repositories:[{path:'repo',branch:'uat'}]}}};
 let now=0;const source=new KnowledgeSource({now:()=>now}),proof=await source.bindings(project,'prd',{repositories:[{path:'repo',branch:'prd',commit}]},[{repository:'repo',path:'route.js'}]);
 assert.equal((await source.current(project,'prd',proof[0])).same,true);
 assert.equal(await git(repo,'branch','--show-current'),'personal');assert.equal((await source.current(project,'uat',proof[0])).reason,'source_scope_changed');
 await git(repo,'checkout','--','route.js');await git(repo,'checkout','prd');await writeFile(path.join(repo,'route.js'),'PRD changed');await git(repo,'add','.');await git(repo,'commit','-m','advance');await git(repo,'push','origin','prd');now=31000;
 assert.equal((await source.current(project,'prd',proof[0])).same,false);
});
