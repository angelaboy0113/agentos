import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {saveEncryptedCredential} from '../src/shared/credential-vault.js';
const exec=promisify(execFile);
test('real instance launcher selects its own encrypted vault after scrubbing inherited deployment variables',async t=>{
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'instance-vault-')),program=path.join(root,'agentos'),runtime=path.join(root,'runtime'),config=path.join(program,'config');t.after(()=>rm(root,{recursive:true,force:true}));
 for(const p of [config,path.join(program,'scripts'),path.join(program,'src/control-plane'),path.join(runtime,'lark-cli'),path.join(root,'systems/demo')])await mkdir(p,{recursive:true});
 await writeFile(path.join(program,'package.json'),'{"type":"module"}');await exec('git',['init','-b','codex/test',program]);
 for(const name of ['run-system-instance.mjs','instance-memory.mjs','run-system-instance.sh'])await copyFile(new URL('../scripts/'+name,import.meta.url),path.join(program,'scripts',name));
 await writeFile(path.join(runtime,'instance.local.json'),JSON.stringify({branch:'codex/test',port:18788}));await writeFile(path.join(runtime,'lark-cli/config.json'),'{}');
 const projects={projects:{demo:{repoPath:path.join(root,'systems/demo')}},ownerOpenIdsByProfile:{bot:['ou_owner']},chatProfileProjectMap:{group:{bot:'demo'}}};
 await writeFile(path.join(config,'projects.local.json'),JSON.stringify(projects));await writeFile(path.join(config,'agents.local.json'),JSON.stringify({agents:{demo:{systemAssistant:true,profile:'bot',openId:'ou_bot',allowedChatIds:['group'],projectId:'demo',displayName:'Demo'}}}));
 await writeFile(path.join(program,'src/control-plane/config.js'),`import{readFile}from'node:fs/promises';export const loadProjects=async p=>JSON.parse(await readFile(p,'utf8'));export const loadAgents=loadProjects;`);
 await saveEncryptedCredential('fixture',{username:'fixture-user',password:'synthetic-secret'},{directory:path.join(runtime,'secure/credential-vault')});
 const vaultModule=new URL('../src/shared/credential-vault.js',import.meta.url).href;
 await writeFile(path.join(program,'src/control-plane/local.js'),`import{writeFile}from'node:fs/promises';import{getHeapStatistics}from'node:v8';import{readEncryptedCredential,credentialVaultDirectory}from${JSON.stringify(vaultModule)};const c=await readEncryptedCredential('fixture');await writeFile(process.env.AGENTOS_DATA_DIR+'/proof.json',JSON.stringify({vault:credentialVaultDirectory(),heapLimit:getHeapStatistics().heap_size_limit,user:c.username==='fixture-user',password:c.password==='synthetic-secret',inherited:process.env.AGENTOS_UNTRUSTED}));`);
 const result=await exec('sh',[path.join(program,'scripts/run-system-instance.sh'),'--start'],{env:{...process.env,PATH:path.dirname(process.execPath)+':'+process.env.PATH,AGENTOS_CREDENTIAL_VAULT_DIR:'/wrong-instance',AGENTOS_UNTRUSTED:'poison'}});
 assert.doesNotMatch(result.stdout,/synthetic-secret/);const proof=JSON.parse(await readFile(path.join(runtime,'data/proof.json')));assert.ok(proof.heapLimit>=6144*1048576&&proof.heapLimit<6300*1048576);delete proof.heapLimit;assert.deepEqual(proof,{vault:path.join(runtime,'secure/credential-vault'),user:true,password:true});
});
