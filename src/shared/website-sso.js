// Explicit identity-provider pages. They permit login UI observation only, not
// business reads, credential injection, consent, or identity/session sharing.
export function validateLoginPages(pages=[]){
 if(!Array.isArray(pages)||pages.some(value=>{try{const u=new URL(value);return u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.href!==value||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(u.pathname)||!/login|signin|passport|authorize/i.test(u.pathname);}catch{return true;}}))throw Error('SSO页面须为审核后的HTTPS精确登录路径，不得含查询、凭据或通配符');return pages;
}
export function loginPageAllowed(value,navigation){try{const u=new URL(value);if(u.username||u.password)return false;return validateLoginPages(navigation?.pages).includes(u.origin+u.pathname);}catch{return false;}}
