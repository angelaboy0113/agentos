// Drain all in-flight operations before reporting failure. A caller can then
// remove a temporary build safely; no worker can write into it afterwards.
export async function parallelRead(items,run,{concurrency=4}={}){
 const results=new Array(items.length);let next=0,failed=false,firstError;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
  while(!failed){const index=next++;if(index>=items.length)return;
   try{results[index]=await run(items[index],index);}catch(error){if(!failed)firstError=error;failed=true;}
  }
 }));
 if(failed)throw firstError;return results;
}
export async function prepareRepositoryLayers(items,run){
 const pending=items.map((item,index)=>({item,index})),result=new Array(items.length);
 while(pending.length){
  const layer=pending.filter(({item})=>!pending.some(other=>other.item.path!==item.path&&(other.item.path==='.'||item.path.startsWith(other.item.path+'/'))));
  if(!layer.length)throw new Error('Overlapping repository preparation paths');
  await parallelRead(layer,async({item,index})=>{result[index]=await run(item,index);},{concurrency:3});
  for(const entry of layer)pending.splice(pending.indexOf(entry),1);
 }
 return result;
}
