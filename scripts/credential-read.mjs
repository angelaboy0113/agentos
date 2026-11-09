#!/usr/bin/env node
import {readEncryptedCredential} from '../src/shared/credential-vault.js';
const [ref,field='password']=process.argv.slice(2);
if(process.stdout.isTTY||!['username','password'].includes(field))process.exit(1);
try{const value=await readEncryptedCredential(ref);process.stdout.write(value[field]);}catch{process.exit(1);}
