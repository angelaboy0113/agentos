// Plain JSON drafts with lazy accessors, not Proxy objects: structuredClone remains
// usable by existing trusted transaction callbacks. Cached records are never mutated.
const object=v=>v!==null&&typeof v==='object';
export function stateDraft(base){
 const metadata=new WeakMap();let active=true,materialized=0;
 function wrap(value){
  if(!object(value))return value;
  const draft=Array.isArray(value)?new Array(value.length):{},children=new Map(),assigned=new Map(),meta={base:value,draft,children,assigned};metadata.set(draft,meta);
  for(const key of Object.keys(value))Object.defineProperty(draft,key,{enumerable:true,configurable:true,
   get(){if(!active)throw Error('Transaction draft is closed');if(assigned.has(key))return assigned.get(key);if(!object(value[key]))return value[key];if(!children.has(key)){children.set(key,wrap(value[key]));materialized++;}return children.get(key);},
   set(next){if(!active)throw Error('Transaction draft is closed');assigned.set(key,next);children.delete(key);}});
  return draft;
 }
 function normalize(value){
  if(metadata.has(value))return finish(value);
  if(!object(value))return ['function','symbol'].includes(typeof value)?undefined:typeof value==='number'&&!Number.isFinite(value)?null:value;
  // Newly supplied JSON payloads are detached once, not the entire history.
  return JSON.parse(JSON.stringify(value));
 }
 function finish(value){
  const m=metadata.get(value);if(!m)return normalize(value);
  const before=m.base,array=Array.isArray(value),index=k=>/^(?:0|[1-9]\d*)$/.test(k)&&Number(k)<value.length,keys=Object.keys(value).filter(k=>!array||index(k)),oldKeys=Object.keys(before);let changed=keys.length!==oldKeys.length||(Array.isArray(value)&&value.length!==before.length),copy;
  const put=(k,v)=>{if(!copy)copy=Array.isArray(before)?before.slice():{...before};if(v===undefined&&!Array.isArray(before))delete copy[k];else copy[k]=v===undefined?null:v;};
  for(const k of oldKeys)if(!Object.hasOwn(value,k)){changed=true;if(!copy)copy=Array.isArray(before)?before.slice():{...before};delete copy[k];}
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);let next;
   if('value'in d)next=normalize(d.value);
   else if(m.assigned.has(k))next=normalize(m.assigned.get(k));
   else if(m.children.has(k))next=finish(m.children.get(k));
   else next=before[k];
   if(!Object.hasOwn(before,k)||next!==before[k]){changed=true;put(k,next);}
  }
  if(!changed)return before;if(!copy)copy=Array.isArray(before)?before.slice():{...before};if(Array.isArray(value)){copy.length=value.length;for(let i=0;i<copy.length;i++)if(!Object.hasOwn(copy,i))copy[i]=null;}return copy;
 }
 const draft=wrap(base);
 return {draft,finish:()=>finish(draft),close:()=>{active=false;},metrics:()=>({materializedBranches:materialized})};
}
