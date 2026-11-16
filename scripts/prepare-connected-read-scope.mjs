import fs from 'node:fs/promises';import path from 'node:path';
import {loadEnvironments}from'../src/shared/environment-access.js';
import {prepareConnectedReadScope}from'../src/shared/connected-read-scope.js';
const [input,policyFile,output]=process.argv.slice(2);
if(!input||!policyFile||!output||path.resolve(input)===path.resolve(output))throw Error('Usage: prepare-connected-read-scope INPUT POLICY NEW_OUTPUT');
const before=await loadEnvironments(input),policy=JSON.parse(await fs.readFile(policyFile,'utf8')),prepared=prepareConnectedReadScope(before,policy);
await fs.writeFile(output,JSON.stringify(prepared.config,null,2)+'\n',{mode:0o600,flag:'wx'});
try{await loadEnvironments(output);}catch(e){await fs.unlink(output);throw e;}
console.log(JSON.stringify({staged:true,audit:prepared.audit,runtimeGrantChanged:false}));
