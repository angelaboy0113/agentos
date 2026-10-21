// Only installed inside our detached task worker, never on the desktop or control process.
export function fenceParentExit(){
 let normal=false;
 process.once('disconnect',()=>{
  if(normal)return;
  if(process.platform!=='win32'){try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}}
  else process.exit(1); // No automatic Windows tree-exit proof; lease remains fenced.
 });
 return ()=>{normal=true;};
}
