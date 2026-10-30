import {readFile, mkdir, chmod, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

// Explicit business conventions are not cached answers or current data. Keep
// their provenance and revisions separately from source-backed knowledge TTLs.
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sensitive=/(?:https?:\/\/|\/Users\/|\/home\/|\b(?:ou|oc)_[a-z0-9]+|(?:password|passwd|secret|token|credential|密码|密钥)\s*[:：=]|\b\d{6,}\b|\d[\d,.]*\s*(?:元|万元|人民币))/i;
export function validateDefinitionUpdate(u){
 if(!u||typeof u!=='object'||typeof u.environment!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(u.environment)
  ||typeof u.title!=='string'||!u.title.trim()||u.title.length>120
  ||typeof u.definition!=='string'||u.definition.trim().length<6||u.definition.length>4000
  ||typeof u.quote!=='string'||u.quote.trim().length<4||u.quote.length>4000
  ||!Array.isArray(u.aliases)||u.aliases.length>12||u.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>120)
  ||typeof u.previousId!=='string'||u.previousId.length>100||!Number.isInteger(u.previousVersion)||u.previousVersion<0
  ||sensitive.test([u.title,u.definition,u.quote,...u.aliases].join('\n')))throw new Error('Invalid business definition');
 return u;
}
async function scope(actor,projectId,file,settings){
 const cfg=settings??JSON.parse(await readFile(file??path.resolve('config/knowledge.local.json'),'utf8'));
 if(cfg.enabled!==true||!actor.senderId||actor.chatType==='p2p'||actor.visibility==='requester')return null;
 const team=cfg.teams?.find(t=>t.projectId===projectId&&t.chatIds?.includes(actor.chatId)&&t.profiles?.includes(actor.profile)
  &&(!t.membersByProfile||t.membersByProfile[actor.profile]?.includes(actor.senderId)));
 return team?{team:team.id,policy:hash(team)}:null;
}
async function open(dataDir){
 const directory=path.join(dataDir,'knowledge');await mkdir(directory,{recursive:true,mode:0o700});
 if((await lstat(directory)).isSymbolicLink())throw new Error('Unsafe definition directory');
 const file=path.join(directory,'definitions.sqlite');
 const info=await lstat(file).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
 if(info&&(info.isSymbolicLink()||!info.isFile()))throw new Error('Unsafe definition file');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);
 try{await chmod(file,0o600);db.exec(`PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY,team TEXT NOT NULL,environment TEXT NOT NULL,topic TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS definition_version ON definitions(team,environment,topic,version);
 CREATE TABLE IF NOT EXISTS definition_receipts(source TEXT PRIMARY KEY,payload TEXT NOT NULL);`);return db;}catch(e){db.close();throw e;}
}
export async function readBusinessDefinitions({dataDir,actor,projectId,environment,file,settings}){
 try{
  const permitted=await scope(actor,projectId,file,settings);if(!permitted)return [];
  const db=await open(dataDir);
  try{return db.prepare("SELECT payload FROM definitions WHERE team=? AND status='active' ORDER BY rowid").all(permitted.team)
   .map(r=>JSON.parse(r.payload)).filter(r=>r.policy===permitted.policy&&(!environment||r.environment===environment))
   .map(({id,environment,title,aliases,definition,version,confirmedAt})=>({id,environment,title,aliases,definition,version,confirmedAt,provenance:'explicit_user_convention',rule:'稳定业务口径，不是实时金额、源码或查询授权；同范围复用，不重复确认。用户明确纠正后采用新版本；实际取数仍须核实当前来源。'}));}
  finally{db.close();}
 }catch(error){if(error.code==='ENOENT')return [];throw error;}
}
export async function recordBusinessDefinitions({dataDir,actor,projectId,updates,file,settings}){
 if(!updates?.length)return [];
 if(!Array.isArray(updates)||updates.length>12)throw new Error('Invalid definition updates');
 const permitted=await scope(actor,projectId,file,settings);if(!permitted)throw new Error('Business definition scope denied');
 if(!actor.id||!Number.isFinite(Date.parse(actor.createdAt)))throw new Error('Missing definition provenance');
 for(const u of updates){validateDefinitionUpdate(u);if(!String(actor.content??'').includes(u.quote))throw new Error('Definition quote is not from current user message');}
 const db=await open(dataDir),receipt=hash([permitted.team,actor.id]);
 try{
  db.exec('BEGIN IMMEDIATE');
  const done=db.prepare('SELECT payload FROM definition_receipts WHERE source=?').get(receipt);
  if(done){db.exec('COMMIT');return JSON.parse(done.payload);}
  const accepted=[];
  for(const u of updates){
   const prior=u.previousId?db.prepare('SELECT * FROM definitions WHERE id=?').get(u.previousId):null;
   if(u.previousId&&(!prior||prior.team!==permitted.team||prior.environment!==u.environment||prior.status!=='active'||prior.version!==u.previousVersion))throw new Error('Definition changed; use latest revision before correcting');
   const old=prior?JSON.parse(prior.payload):null;
   if(old&&(old.policy!==permitted.policy||Date.parse(old.confirmedAt)>Date.parse(actor.createdAt)))throw new Error('Stale definition correction');
   const topic=old?.topic??hash(u.title.normalize('NFKC').trim().toLowerCase());
   if(!old&&db.prepare("SELECT id FROM definitions WHERE team=? AND environment=? AND topic=? AND status='active'").get(permitted.team,u.environment,topic))throw new Error('Existing definition requires explicit correction revision');
   if(!old&&u.previousVersion!==0)throw new Error('Invalid initial definition revision');
   const entry={id:'DEF-'+randomUUID(),...permitted,environment:u.environment,topic,version:(old?.version??0)+1,
    title:u.title,aliases:u.aliases,definition:u.definition,confirmedAt:actor.createdAt,
    source:{conversationId:actor.id,senderId:actor.senderId,quote:u.quote},previousId:old?.id??null};
   if(old)db.prepare("UPDATE definitions SET status='superseded' WHERE id=?").run(old.id);
   db.prepare('INSERT INTO definitions VALUES(?,?,?,?,?,?,?)').run(entry.id,entry.team,entry.environment,entry.topic,entry.version,'active',JSON.stringify(entry));
   accepted.push({id:entry.id,version:entry.version,title:entry.title,environment:entry.environment});
  }
  db.prepare('INSERT INTO definition_receipts VALUES(?,?)').run(receipt,JSON.stringify(accepted));db.exec('COMMIT');return accepted;
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
export function definitionActor(job){return {senderId:job.senderId,chatId:job.chatId,profile:job.originProfile??job.agentProfile,chatType:job.originChatType??'group',visibility:job.visibility};}
