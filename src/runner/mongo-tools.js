import {sshMongoConnection} from './ssh-mongo.js';import policy from './ssh-mongo-worker.cjs';import {addExact,compareExact} from '../shared/dataset-summary.js';
const input=message=>{throw Object.assign(new Error(message),{code:'REPORT_INPUT'});};
const get=(row,name)=>name.split('.').reduce((v,key)=>v&&Object.hasOwn(v,key)?v[key]:undefined,row);
export function mergeMongoGroups(rows,args){
 const groups=new Map(),numeric=new Set(['double','int','long','decimal']);
 for(const row of rows){const types=row.__mongo_group_types??[],key=JSON.stringify([args.groupColumns.map((c,i)=>types[i]==='number'?addExact(get(row,c),'0'):get(row,c)),types]);let target=groups.get(key);if(!target){target={row:Object.fromEntries(args.groupColumns.map(c=>[c,get(row,c)??null])),types:new Map(),distinct:new Set()};target.row.__mongo_group_types=JSON.stringify(types);groups.set(key,target);}
 for(const item of args.aggregates){const value=row[item.as];
 if(item.op==='count_distinct'){const v=row.__mongo_distinct,t=row.__mongo_distinct_type;target.distinct.add(JSON.stringify([t,t==='number'?addExact(v,'0'):v]));target.row[item.as]=String(target.distinct.size);continue;}
 if(item.op==='count'){target.row[item.as]=String(BigInt(target.row[item.as]??'0')+BigInt(value));continue;}
 const seen=target.types.get(item.as)??new Set();for(const type of row[item.as+'__types']??[])if(!['null','missing'].includes(type))seen.add(type);target.types.set(item.as,seen);if(seen.size>1&&![...seen].every(t=>numeric.has(t)))input('Mongo聚合字段混合不同BSON类型，不能猜测日期或金额含义');
 if(item.op==='sum'){target.row[item.as]=addExact(target.row[item.as]??'0',value);continue;}
 const previous=target.row[item.as];if(value===null||value===undefined){if(previous===undefined)target.row[item.as]=null;continue;}if(previous===undefined||previous===null){target.row[item.as]=value;continue;}
 const comparison=[...seen].every(t=>numeric.has(t))?compareExact(value,previous):Buffer.compare(Buffer.from(value),Buffer.from(previous));if(item.op==='max'?comparison>0:comparison<0)target.row[item.as]=value;
 }}
 if(!groups.size&&!args.groupColumns.length){const row={__mongo_group_types:'[]'};for(const item of args.aggregates)row[item.as]=['count','count_distinct','sum'].includes(item.op)?'0':null;groups.set('[]',{row});}
 return [...groups.values()].map(x=>x.row).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function mongoToolSpec(q){return [
 {tool:'connection',args:{},description:'MongoDB SSH远程连接及实际账号权限元数据；只读命令白名单，不把业务账号声称为数据库只读账号。'},
 {tool:'collections',args:{},description:'完整列出当前数据库、已授权名称范围内的实际集合；集合缺失不能默认为无发生额。'},
 {tool:'schema',args:{collection:'实际集合名'},description:'前100条文档字段与BSON类型普查，仅为抽样结构，不证明所有文档都有该字段。'},
 {tool:'indexes',args:{collection:'实际集合名'},description:'只读索引元数据，用于匹配有界筛选，不改索引。'},
 {tool:'explain_query',args:{collections:['实际集合名'],columns:['字段'],filters:[]},description:'固定只读查询的queryPlanner；同group_dataset/select结构参数，无原始pipeline、命令或执行统计。'},
 {tool:'select',args:{collections:['实际集合名'],columns:['字段'],filters:[{column:'字段',op:'=|>|>=|<|<=|in|in_set|is_null|is_missing|is_not_null',type:'string|date|objectId|int64|decimal|boolean',value:'标量；date必须ISO8601含Z或明确时区偏移，in_set引用完整集合'}]},description:`同一授权数据库内显式集合的有限预览，最多${q.maxRows}行。空值与字段不存在分别标记，不将样本当全集。`},
 {tool:'group_dataset',args:{collections:['所有实际月份集合'],groupColumns:['实际分组字段'],aggregates:[{op:'count|min|max|sum|count_distinct',column:'count以外实际字段',as:'结果别名'}],filters:[],cohort:{datasetRef:'可选：完整主对象数据集',columns:['对象ID字段'],column:'Mongo关联字段',type:'string|objectId|int64',nulls:'exclude|error'}},description:'显式月份集合先合并后分组，完整游标读取，不设总行数截停；每个集合必须实际存在。也可只传columns读取完整原始记录。count_distinct须单独一项且跨集合去重；sum遇到真实空值拒绝猜零。cohort从已保存完整数据集恢复全部键，配方可重放，不依赖临时setRef。分库/跨月读取不宣称事务快照。'},
 {tool:'count',args:{collections:['实际集合名'],filters:[],cohort:'与group_dataset相同'},description:'独立固定COUNT，完整集合与相同筛选，不用预览行数作业务总数。'}
];}
export function createMongoBackend(e,q,cred,{datasets,valueSets,...adapters}){
 const redact=value=>typeof value==='string'?[cred.username,cred.password].filter(Boolean).reduce((s,secret)=>s.split(secret).join('[已隐藏]'),value):value;
 let connection;const connect=async()=>connection??=await (adapters.mongoConnection??sshMongoConnection)(e,q,cred,adapters);
 async function fixed(args){
 const original=structuredClone(args),copy=structuredClone(args);if(copy.collection){copy.collections=[copy.collection];delete copy.collection;}
 const cohort=copy.cohort;delete copy.cohort;if(cohort){if(!policy.field(cohort.column)||!Array.isArray(cohort.columns)||!cohort.columns.length||!['error','exclude'].includes(cohort.nulls))input('cohort需要实际字段和明确空值处理');const d=await datasets.restore(cohort.datasetRef);if(!d?.complete||cohort.columns.some(c=>!d.columns.includes(c)))input('cohort需要本任务完整数据集及真实字段');const values=new Set();for(const row of d.rows)for(const column of cohort.columns){const v=row[column];if(v===null||v===undefined||v===''){if(cohort.nulls==='error')input('主对象集合存在空键；不能丢失后猜零');continue;}values.add(String(v));}if(!values.size)input('主对象集合为空；先核对业务范围，不能隐式查询全部记录');copy.filters=[...(copy.filters??[]),{column:cohort.column,op:'in',type:cohort.type,value:[...values]}];}
 copy.filters=(copy.filters??[]).map(f=>{if(f.op!=='in_set')return f;const set=valueSets.get(f.value);if(!set||set.truncated||!set.values.length)input('in_set只能使用本轮完整集合；跨轮优先使用可重放cohort');return {...f,op:'in',value:[...set.values]};});
 policy.validateArgs(copy,q.collections);return {copy,original};
 }
 async function run(tool,args={}){
 await datasets.check();const conn=await connect();
 if(tool==='connection')return conn.request('connection');if(tool==='collections')return conn.request('collections');
 if(['schema','indexes'].includes(tool)){const {copy}=await fixed(args);return conn.request(tool,copy);}
 let {copy,original}=await fixed(args);if(tool==='count')copy={...copy,groupColumns:[],aggregates:[{op:'count',as:'total'}]};
 if(tool==='explain_query'){const plans=[];for(const collection of copy.collections)plans.push({collection,...await conn.request('explain',{...copy,collections:[collection]})});return {plans,businessQueryExecuted:false};}
 if(!['group_dataset','select','count'].includes(tool))input('未提供该Mongo只读工具；不能传入原始命令或pipeline');
 const columns=copy.aggregates?[...(copy.groupColumns??[]),...copy.aggregates.map(x=>x.as),'__mongo_group_types']:[...copy.columns,'__mongo_collection','__mongo_missing'];
 if(new Set(columns).size!==columns.length)input('Mongo输出列重复');policy.pipeline(copy);
 const startedAt=new Date().toISOString(),collected=[],sourceReads=[];let complete=true;
 // Sequential fixed reads also work on legacy Mongo servers without $unionWith.
 for(const collection of copy.collections){const from=new Date().toISOString();let typeAudits=[];let page=await conn.request('read',{...copy,collections:[collection]});for(;;){if(page.typeAudits)typeAudits=page.typeAudits;await datasets.check();for(const row of page.rows){collected.push(copy.aggregates?row:Object.fromEntries(columns.map(column=>{if(column==='__mongo_collection')return [column,collection];if(column==='__mongo_missing')return [column,JSON.stringify(copy.columns.filter(c=>get(row,c)===undefined))];let value=get(row,column);if(value===undefined)value=null;if(value!==null&&typeof value==='object')value=JSON.stringify(value);return [column,value];})));if(tool==='select'&&collected.length>q.maxRows)break;}
 if(tool==='select'&&collected.length>q.maxRows){complete=false;if(page.nextCursor)await conn.request('cursor_close',{cursor:page.nextCursor});break;}if(page.complete)break;page=await conn.request('cursor_next',{cursor:page.nextCursor});}
 sourceReads.push({collection,startedAt:from,completedAt:new Date().toISOString(),typeAudits});if(!complete)break;}
 const rows=(copy.aggregates?mergeMongoGroups(collected,copy):collected).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,redact(value)])));
 if(tool==='select')return {rows:rows.slice(0,q.maxRows),truncated:rows.length>q.maxRows||!complete,complete:complete&&rows.length<=q.maxRows,sourceRead:{startedAt,completedAt:new Date().toISOString(),collections:copy.collections,sameTransactionSnapshot:false}};
 if(tool==='count')return {rows:rows.length?rows:[{total:'0'}],complete:true,truncated:false,sourceRead:{startedAt,completedAt:new Date().toISOString(),collections:copy.collections,sameTransactionSnapshot:false}};
 if(!complete||q.exportMaxRows!=='all'&&rows.length>q.exportMaxRows)input('Mongo完整读取尚未结束，不能保存为完整来源；请核对管理员导出配置');
 // Kind plus canonical fixed arguments keep query evidence independent of SQL parsing.
 const queryDefinition={kind:'mongodb',sql:JSON.stringify({kind:'mongodb',operation:'group_dataset',arguments:copy}),params:[]};
 const saved=await datasets.captureRows(rows,columns,{complete:true,queryDefinition,numericColumns:copy.aggregates?.filter(x=>['count','count_distinct','sum'].includes(x.op)).map(x=>x.as)??[],recipe:{tool:'mongo_dataset',args:original},sourceRead:{startedAt,completedAt:new Date().toISOString(),collections:copy.collections,sourceReads,transport:'ssh-remote-execution',readConcern:e.readConcern??'local',sameTransactionSnapshot:false}});
 return {...saved,stage:'MongoDB完整游标来源已保存；保留显式集合与取数时间，仍须独立核验和文件检查',preview:rows.slice(0,Math.min(q.maxRows,20)),columns,complete:true,truncated:false};
 }
 return {run,reload:args=>run('group_dataset',args),close:()=>{connection?.destroy();connection=null;}};
}
