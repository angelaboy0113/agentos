import {websiteUrl} from './website-policy.js';
// Only a maintainer-configured application root may bind independent questions to one login entry.
export function websiteApplication(config,projectId,tier,url){
 const target=new URL(websiteUrl(url));
 const matches=Object.entries(config.environments??{}).filter(([,entry])=>{
  if(entry.kind!=='website'||entry.applicationRoot!==true||entry.projectId!==projectId||entry.tier!==tier)return false;
  const base=new URL(websiteUrl(entry.baseUrl)),prefix=base.pathname.replace(/\/$/,'');
  return base.origin===target.origin&&(target.pathname===prefix||target.pathname.startsWith(prefix+'/'));
 }).sort((a,b)=>new URL(b[1].baseUrl).pathname.length-new URL(a[1].baseUrl).pathname.length);
 if(matches.length>1&&new URL(matches[0][1].baseUrl).pathname.replace(/\/$/,'')===new URL(matches[1][1].baseUrl).pathname.replace(/\/$/,''))throw new Error('网站应用入口配置存在歧义，未猜选凭据或读取范围');
 return matches.length?{environmentId:matches[0][0],entry:matches[0][1]}:null;
}
