import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../src/shared/maintenance-backups.js';
import {loadEnvironments} from '../src/shared/environment-access.js';
import {planWebsiteReadReview} from '../src/shared/website-read-review.js';

const [file, reviewPath, auditPath, mode] = process.argv.slice(2);
if (!file || !reviewPath || !auditPath || mode !== '--apply') {
  throw Error('Usage: review-website-read.mjs <private-environments.json> <private-source-review.json> <private-audit.json> --apply');
}
const before = await readFile(file, 'utf8');
const config = JSON.parse(before);
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const plan = planWebsiteReadReview(config, review);
if (!plan) {
  console.log('Read rule already exists');
} else {
  config.environments[review.environmentId].queries[review.queryId].readEndpoints = plan.next;
  const staged = file+'.'+randomUUID()+'.review';
  try {
    await writeFile(staged,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    await loadEnvironments(staged);
    await atomicJson(auditPath,{status:'validated',at:new Date().toISOString(),review,rule:plan.rule});
    if (await readFile(file,'utf8') !== before) throw Error('Environment config changed during review; rerun against current config');
    await rename(staged,file);
    await atomicJson(auditPath,{status:'applied',at:new Date().toISOString(),review,rule:plan.rule});
    console.log('Exact reviewed read rule applied');
  } finally {
    await rm(staged,{force:true});
  }
}
