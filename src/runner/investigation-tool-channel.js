import {PlannerInputCursor} from './planner-input.js';

// An existing authorized investigator acts as a coroutine. Its tools, result
// persistence, login checkpoints and report checks stay unchanged; the outer
// Codex thread supplies choices instead of spawning an environment model.
export class InvestigationToolChannel {
  constructor() { this.cursor=new PlannerInputCursor();this.waiters=[];this.revision=0; }
  planner() { return {next:input=>this.next(input),stats:()=>({...this.cursor.bytes}),close:async()=>{}}; }
  next(input) {
    if(this.closed) return Promise.resolve({tool:'finish',arguments:'{}',summary:'会话关闭，保留已取得证据。',complete:false});
    if(this.resolveChoice)throw new Error('Concurrent investigator choice');
    return new Promise(resolve=>{this.resolveChoice=resolve;this.publish({state:'tools',input:this.cursor.next({...input,...(this.instructions?{environmentToolInstructions:this.instructions}:{})})});});
  }
  publish(value) { this.value=value;this.revision++;for(const resolve of this.waiters.splice(0))resolve(value); }
  settle(result) { this.resolveChoice=null;this.publish({state:'finished',result}); }
  fail(error) { this.resolveChoice=null;this.publish({state:'failed',error}); }
  async observe(after=0) {
    const value=this.revision>after?this.value:await new Promise(resolve=>this.waiters.push(resolve));
    if(value.state==='failed')throw value.error;
    return value;
  }
  async choose(choice) {
    if(this.closed||!this.resolveChoice)throw new Error('No active environment choice');
    const before=this.revision,resolve=this.resolveChoice;this.resolveChoice=null;resolve(choice);
    return this.observe(before);
  }
  async stop() {
    if(this.closed)return;
    this.closed=true;
    this.resolveChoice?.({tool:'finish',arguments:'{}',summary:'外层调查结束，原环境证据保留。',complete:false});
    this.resolveChoice=null;
  }
}
