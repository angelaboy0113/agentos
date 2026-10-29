// TCE private-cloud TCT adapter: trusted deployment configuration only.
export function validateTct(e) {
 const c=e.tct;
 if(!c||Object.keys(c).some(k=>!['loginOrigin','consoleOrigin','apiOrigin','ownerUin','region'].includes(k)))throw Error('TCT requires reviewed cloud endpoints');
 for(const key of ['loginOrigin','consoleOrigin','apiOrigin']){const u=new URL(c[key]);if(u.protocol!=='https:'||u.username||u.password||u.origin!==c[key])throw Error('TCT endpoints must be HTTPS origins');}
 if(!/^\d+$/.test(c.ownerUin)||typeof c.region!=='string'||!c.region.trim())throw Error('TCT tenant and region required');
}
export function validateTctQuery(q){if(q.mode!=='investigate'||!Array.isArray(q.groupIds)||!q.groupIds.length||new Set(q.groupIds).size!==q.groupIds.length||q.groupIds.some(x=>!/^group-[a-zA-Z0-9]+$/.test(x)))throw Error('TCT requires explicit reviewed group IDs');}
