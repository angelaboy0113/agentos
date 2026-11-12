import fs from 'node:fs/promises';import path from 'node:path';
import {renderInterfaceDocument} from '../src/shared/interface-document.js';
const [workspace,input,output]=process.argv.slice(2);
if(!workspace||!input||!output)throw Error('Usage: node render-interface-document.mjs WORKING INPUT.json OUTPUT.html');
const root=await fs.realpath(workspace);
async function local(name,existing){
 if(path.isAbsolute(name)||name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('Artifact path must be relative');
 const file=path.join(root,name),parent=await fs.realpath(path.dirname(file));if(parent!==root&&!parent.startsWith(root+path.sep))throw Error('Artifact outside working');
 const s=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT'&&!existing)return null;throw e;});if(s&&(!s.isFile()||s.isSymbolicLink()||s.nlink!==1))throw Error('Artifact must be a regular independent file');return file;
}
const source=await local(input,true),target=await local(output,false);if(source===target)throw Error('Do not overwrite evidence');
const spec=JSON.parse(await fs.readFile(source,'utf8')),html=renderInterfaceDocument(spec);await fs.writeFile(target,html,{flag:'wx',mode:0o600});console.log(JSON.stringify({endpoints:spec.endpoints.length,models:spec.models?.length??0,bytes:Buffer.byteLength(html),output,sourceInputPreserved:true}));
