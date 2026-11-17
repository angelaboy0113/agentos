// Trusted deployment configuration, never a model-selected host or URL.
export const cnbRepository = value => typeof value==='string' && value.split('/').length>=2 && value.split('/').every(x=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(x)&&x!=='.'&&x!=='..');
export function validateCnb(e){
 if(!e.cnb||Object.keys(e.cnb).some(k=>!['apiOrigin','resources'].includes(k))||e.cnb.apiOrigin!=='https://api.cnb.cool')throw Error('CNB requires the reviewed official HTTPS API origin');
 if(e.cnb.resources!==undefined&&(!Array.isArray(e.cnb.resources)||e.cnb.resources.length!==1||new Set(e.cnb.resources).size!==e.cnb.resources.length||e.cnb.resources.some(x=>!['build-history','pull-requests'].includes(x))))throw Error('CNB resources require explicit reviewed read-only capabilities');
}
export function validateCnbQuery(q){
 if(q.mode!=='investigate'||!Array.isArray(q.repositories)||!q.repositories.length||new Set(q.repositories).size!==q.repositories.length||q.repositories.some(x=>!cnbRepository(x))||q.maxRows>100)throw Error('CNB requires exact repository paths and a page size up to 100');
}
