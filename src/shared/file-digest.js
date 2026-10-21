import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
// Digest artifacts without loading an entire file into the control plane heap.
export async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
