import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCredential,readEncryptedCredential,saveEncryptedCredential} from '../src/shared/credential-vault.js';
import {credential} from '../src/runner/environment-connector.js';

test('encrypted credential vault is unattended, private, tamper evident and only uses legacy Keychain when explicitly requested',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'agentos-vault-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await saveEncryptedCredential('fixture',{username:'reader',password:'private-value'},{directory});
 assert.deepEqual(await readEncryptedCredential('fixture',{directory}),{username:'reader',password:'private-value'});
 assert.equal((await stat(path.join(directory,'master.key'))).mode&0o777,0o600);assert.equal((await stat(path.join(directory,'credentials.enc'))).mode&0o777,0o600);
 assert.doesNotMatch(await readFile(path.join(directory,'credentials.enc'),'utf8'),/reader|private-value/);
 let fallbacks=0;await assert.rejects(readCredential('legacy',async()=>{fallbacks++;return{username:'old',password:'secret'};},{directory}),error=>error.code==='CREDENTIAL_NOT_FOUND');assert.equal(fallbacks,0);
 assert.deepEqual(await readCredential('legacy',async()=>{fallbacks++;return{username:'old',password:'secret'};},{directory,allowLegacyKeychain:true}),{username:'old',password:'secret'});assert.deepEqual(await readCredential('legacy',async()=>{fallbacks++;throw Error('must not run');},{directory}),{username:'old',password:'secret'});assert.equal(fallbacks,1);
 const file=path.join(directory,'credentials.enc'),body=await readFile(file);body[body.length-2]^=1;await writeFile(file,body);await assert.rejects(readEncryptedCredential('fixture',{directory}),/完整性/);
});

test('formal connector never falls back to an interactive macOS Keychain read',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'agentos-vault-service-')),previous=process.env.AGENTOS_CREDENTIAL_VAULT_DIR;
 process.env.AGENTOS_CREDENTIAL_VAULT_DIR=directory;
 t.after(async()=>{if(previous===undefined)delete process.env.AGENTOS_CREDENTIAL_VAULT_DIR;else process.env.AGENTOS_CREDENTIAL_VAULT_DIR=previous;await rm(directory,{recursive:true,force:true});});
 await assert.rejects(credential('missing-web-entry'),/尚未迁移.*missing-web-entry.*不会弹出 macOS 钥匙串确认/);
});
