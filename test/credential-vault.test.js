import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCredential,readEncryptedCredential,saveEncryptedCredential} from '../src/shared/credential-vault.js';

test('encrypted credential vault is unattended, private, tamper evident and lazily migrates once',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'agentos-vault-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await saveEncryptedCredential('fixture',{username:'reader',password:'private-value'},{directory});
 assert.deepEqual(await readEncryptedCredential('fixture',{directory}),{username:'reader',password:'private-value'});
 assert.equal((await stat(path.join(directory,'master.key'))).mode&0o777,0o600);assert.equal((await stat(path.join(directory,'credentials.enc'))).mode&0o777,0o600);
 assert.doesNotMatch(await readFile(path.join(directory,'credentials.enc'),'utf8'),/reader|private-value/);
 let fallbacks=0;assert.deepEqual(await readCredential('legacy',async()=>{fallbacks++;return{username:'old',password:'secret'};},{directory}),{username:'old',password:'secret'});assert.deepEqual(await readCredential('legacy',async()=>{fallbacks++;throw Error('must not run');},{directory}),{username:'old',password:'secret'});assert.equal(fallbacks,1);
 const file=path.join(directory,'credentials.enc'),body=await readFile(file);body[body.length-2]^=1;await writeFile(file,body);await assert.rejects(readEncryptedCredential('fixture',{directory}),/完整性/);
});
