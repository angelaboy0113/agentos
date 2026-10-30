import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');

// One cursor per ephemeral planner thread. Full audit results remain in the runner;
// the model receives changes, rather than appending the same catalog and rows on
// every turn. A newly created planner always starts with a complete envelope.
export class PlannerInputCursor {
  constructor(){this.fields=new Map();this.tail=[];this.sequence=0;this.toolCount=null;this.bytes={full:0,sent:0};}
  next(input){
    const {results=[],...fields}=input,changed={},cleared=[];
    for(const key of this.fields.keys())if(!Object.hasOwn(fields,key)){cleared.push(key);this.fields.delete(key);}
    for(const [key,value] of Object.entries(fields)){
      const signature=hash(value);
      if(this.fields.get(key)!==signature){changed[key]=value;this.fields.set(key,signature);}
    }
    const keys=results.map(hash);let overlap=Math.min(this.tail.length,keys.length);
    while(overlap&&!this.tail.slice(-overlap).every((key,i)=>key===keys[i]))overlap--;
    const count=input.progress?.toolCount;
    if(Number.isInteger(count)&&this.toolCount!==null&&count>=this.toolCount)overlap=Math.max(0,results.length-(count-this.toolCount));
    if(Number.isInteger(count))this.toolCount=count;
    const message={protocol:'planner-delta-v1',sequence:++this.sequence,...changed,
      results:results.slice(overlap),...(cleared.length?{cleared}:{}),
      contextPolicy:'Changed fields replace their prior value; omitted fields remain unchanged. results append new observations in order; identical observations can recur. Nothing is a new permission. Current reportState/progress are authoritative; full artifacts remain available through tools.'};
    this.tail=keys;
    this.bytes.full+=Buffer.byteLength(JSON.stringify(input));this.bytes.sent+=Buffer.byteLength(JSON.stringify(message));
    return message;
  }
}
