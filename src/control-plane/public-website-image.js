import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList, isIP} from 'node:net';
import {Readable} from 'node:stream';

const restricted = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) restricted.addSubnet(network,prefix);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) restricted.addSubnet(network,prefix,'ipv6');

export function isPublicImageAddress(address){
 const family=isIP(address);
 if(family===4)return !restricted.check(address,'ipv4');
 return family===6&&globalV6.check(address,'ipv6')&&!restricted.check(address,'ipv6');
}

export function passivePublicImage(request, frameUrl, base){
 if(request.method!=='GET'||request.resourceType!=='image')return false;
 try{
  const url=new URL(request.url), origin=new URL(base).origin;
  return new URL(frameUrl).origin===origin&&url.origin!==origin&&url.protocol==='https:'&&!url.port
   &&!url.username&&!url.password&&!url.search&&!url.hash
   &&!/\.(?:localhost|local|internal)\.?$/i.test(url.hostname)
   &&/\.(?:jpe?g|png|gif|webp|avif|bmp|ico)$/i.test(url.pathname);
 }catch{return false;}
}

// Resolve once and pin the validated address to the TLS connection. A second
// resolver lookup could let the same asset hostname point at a private service.
export async function fetchPassivePublicImage(input,{signal,resolve=lookup,connect=request}={}){
 const url=new URL(input),host=url.hostname.replace(/^\[|\]$/g,'');
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash)throw Error('Invalid image URL');
 const family=isIP(host);
 const addresses=family?[{address:host,family}]:await resolve(host,{all:true});
 signal?.throwIfAborted();
 const target=addresses.find(entry=>isPublicImageAddress(entry.address));
 if(!target)throw Error('Image host has no public address');
 return new Promise((resolve,reject)=>{
  const client=connect(url,{
   method:'GET',agent:false,signal,family:target.family,
   lookup:(_name,options,done)=>options.all?done(null,[target]):done(null,target.address,target.family),
  },res=>{
   if(res.statusCode!==200){res.destroy();resolve(new Response(null,{status:res.statusCode}));return;}
   resolve(new Response(Readable.toWeb(res),{status:200,headers:{
    'content-type':res.headers['content-type']??'application/octet-stream',
   }}));
  });
  client.once('error',reject);
  client.end();
 });
}
