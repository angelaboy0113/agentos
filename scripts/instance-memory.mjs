import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export function mainHeapMiB(instance={}){
 const value=instance.mainHeapMiB??6144;
 if(!Number.isSafeInteger(value)||value<512||value>65536)throw Error('mainHeapMiB must be an integer from 512 to 65536');
 return value;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(mainHeapMiB(JSON.parse(await readFile(new URL('../../runtime/instance.local.json',import.meta.url),'utf8'))));
