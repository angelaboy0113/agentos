// Operator-only recovery into a NEW empty directory; never overlays runtime data.
import {restoreBackupContent} from '../src/shared/backup-content-store.js';
import {acquire} from '../src/shared/maintenance-backups.js';
import path from 'node:path';
const [manifest,destination,managedRoot]=process.argv.slice(2);
if(!manifest||!destination||!managedRoot)throw Error('Usage: restore-backup-content.mjs MANIFEST NEW_EMPTY_DIRECTORY MANAGED_ROOT');
const release=await acquire(path.resolve(managedRoot));if(!release)throw Error('Maintenance busy');
try{console.log(JSON.stringify(await restoreBackupContent(path.resolve(manifest),{destination:path.resolve(destination),managedRoot:path.resolve(managedRoot)})));}finally{await release();}
