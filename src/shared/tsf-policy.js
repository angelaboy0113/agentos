const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'-[A-Za-z0-9]+$').test(v);
export function validateTsf(e){
 const c=e.tsf;
 if(!c||Object.keys(c).some(k=>!['loginOrigin','consoleOrigin','apiOrigin','ownerUin','region','timeZone'].includes(k)))throw Error('TSF requires reviewed cloud endpoints');
 for(const k of ['loginOrigin','consoleOrigin','apiOrigin']){const u=new URL(c[k]);if(u.protocol!=='https:'||u.username||u.password||u.origin!==c[k])throw Error('TSF endpoints must be HTTPS origins');}
 if(!/^\d+$/.test(c.ownerUin)||typeof c.region!=='string'||!c.region||typeof c.timeZone!=='string')throw Error('TSF account, region and timestamp timezone required');
 try{new Intl.DateTimeFormat('en',{timeZone:c.timeZone});}catch{throw Error('TSF timestamp timezone invalid');}
}
export function validateTsfQuery(q){
 if(q.mode!=='investigate'||!Array.isArray(q.applications)||!q.applications.length)throw Error('TSF requires explicit reviewed application/group/namespace scope');
 if(q.configurationApplications!==undefined&&(!Array.isArray(q.configurationApplications)||new Set(q.configurationApplications).size!==q.configurationApplications.length||q.configurationApplications.some(x=>!q.applications.some(a=>a.applicationId===x))))throw Error('Configuration discovery requires an explicit application subset');
 const apps=new Set(),groups=new Set();
 for(const a of q.applications){if(!a||Object.keys(a).some(k=>!['applicationId','applicationName','groups'].includes(k))||!id(a.applicationId,'application')||apps.has(a.applicationId)||typeof a.applicationName!=='string'||!a.applicationName||!Array.isArray(a.groups)||!a.groups.length)throw Error('Invalid TSF application scope');apps.add(a.applicationId);
  for(const g of a.groups){if(!g||Object.keys(g).some(k=>!['groupId','namespaceId'].includes(k))||!id(g.groupId,'group')||!id(g.namespaceId,'namespace')||groups.has(g.groupId))throw Error('Invalid or duplicate TSF group scope');groups.add(g.groupId);}
 }
}
