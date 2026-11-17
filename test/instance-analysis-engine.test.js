import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
for(const selection of [undefined,'native-tools-v1','invalid'])test(`actual instance launcher fences engine selection: ${selection??'legacy default'}`,async t=>{
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'instance-engine-')),program=path.join(root,'agentos'),runtime=path.join(root,'runtime');t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['config','scripts','src/control-plane'])await mkdir(path.join(program,dir),{recursive:true});
 await mkdir(path.join(runtime,'lark-cli'),{recursive:true});await mkdir(path.join(root,'systems/demo'),{recursive:true});
 await writeFile(path.join(program,'package.json'),'{"type":"module"}');await exec('git',['init','-b','codex/test',program]);
 for(const file of ['run-system-instance.mjs','instance-memory.mjs'])await copyFile(new URL('../scripts/'+file,import.meta.url),path.join(program,'scripts',file));
 await writeFile(path.join(runtime,'instance.local.json'),JSON.stringify({branch:'codex/test',port:18788,...(selection?{analysisEngine:selection}:{})}));await writeFile(path.join(runtime,'lark-cli/config.json'),'{}');
 await writeFile(path.join(program,'config/projects.local.json'),JSON.stringify({projects:{demo:{repoPath:path.join(root,'systems/demo')}},ownerOpenIdsByProfile:{bot:['owner']},chatProfileProjectMap:{group:{bot:'demo'}}}));
 await writeFile(path.join(program,'config/agents.local.json'),JSON.stringify({agents:{bot:{systemAssistant:true,profile:'bot',openId:'bot',allowedChatIds:['group'],projectId:'demo',displayName:'Synthetic'}}}));
 await writeFile(path.join(program,'src/control-plane/config.js'),`import{readFile}from'node:fs/promises';export const loadProjects=async p=>JSON.parse(await readFile(p));export const loadAgents=loadProjects;`);
 const runnerModule=new URL('../src/runner/config.js',import.meta.url).href;
 await writeFile(path.join(program,'src/control-plane/local.js'),`import{writeFile}from'node:fs/promises';import{runnerConfig}from${JSON.stringify(runnerModule)};const c=await runnerConfig({projects:{}});await writeFile(process.env.AGENTOS_DATA_DIR+'/engine.json',JSON.stringify({engine:c.analysisEngine,foreign:process.env.AGENTOS_FOREIGN}));`);
 const run=()=>exec(process.execPath,[path.join(program,'scripts/run-system-instance.mjs'),'--start'],{env:{...process.env,AGENTOS_ANALYSIS_ENGINE:'foreign-value',AGENTOS_FOREIGN:'poison'}});
 if(selection==='invalid'){await assert.rejects(run,/Unsupported instance analysisEngine/);await assert.rejects(readFile(path.join(runtime,'data/engine.json')),{code:'ENOENT'});}
 else{await run();assert.deepEqual(JSON.parse(await readFile(path.join(runtime,'data/engine.json'))),{engine:selection??'legacy'});}
});
