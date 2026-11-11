// Trusted deployment configuration, never a model-selected host or URL.
export const cnbRepository = value => typeof value==='string' && value.split('/').length>=2 && value.split('/').every(x=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(x)&&x!=='.'&&x!=='..');
export function validateCnb(e){
 if(!e.cnb||Object.keys(e.cnb).length!==1||e.cnb.apiOrigin!=='https://api.cnb.cool')throw Error('CNB requires the reviewed official HTTPS API origin');
}
export function validateCnbQuery(q){
 if(q.mode!=='investigate'||!Array.isArray(q.repositories)||!q.repositories.length||new Set(q.repositories).size!==q.repositories.length||q.repositories.some(x=>!cnbRepository(x))||q.maxRows>100)throw Error('CNB requires exact repository paths and a page size up to 100');
}
