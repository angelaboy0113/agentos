#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {environmentFile} from '../src/shared/environment-access.js';
import {readEncryptedCredential,saveEncryptedCredential} from '../src/shared/credential-vault.js';

const exec=promisify(execFile),helper=fileURLToPath(new URL('./keychain-credential.py',import.meta.url));
const config=JSON.parse(await readFile(environmentFile(),'utf8')),refs=new Set();
const visit=value=>{if(Array.isArray(value)){for(const item of value)visit(item);return;}if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(/credentialRef$/i.test(key)&&typeof item==='string')refs.add(item);else visit(item);}};
visit(config);
let existing=0,migrated=0,failed=0;
for(const ref of refs){
 try{await readEncryptedCredential(ref);existing++;continue;}catch(error){if(error.code!=='CREDENTIAL_NOT_FOUND')throw error;}
 try{const {stdout}=await exec('/usr/bin/python3',[helper,'get',ref],{timeout:60_000,maxBuffer:16_000});await saveEncryptedCredential(ref,JSON.parse(stdout));migrated++;}catch{failed++;}
}
process.stdout.write(JSON.stringify({total:refs.size,existing,migrated,failed})+'\n');
if(failed)process.exitCode=2;
