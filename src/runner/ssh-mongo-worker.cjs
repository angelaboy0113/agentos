// Only this fixed read protocol runs on the approved SSH host. No user pipelines or commands.
const {MongoClient,ObjectId,Long,Decimal128}=require('mongodb');const {randomUUID}=require('node:crypto');
const sensitive=/password|passwd|secret|token|credential|private.?key|api.?key|access.?key|authorization|cookie|身份证|手机号|银行卡/i;
function diagnostics(error){const text=[error?.message,...[...(error?.reason?.servers?.values?.()??[])].map(x=>x.error?.message)].filter(Boolean).join(' ');const wire=/wire version (\d+)/i.exec(text),minimum=/requires at least (\d+)|minimum wire version (\d+)/i.exec(text);let code=/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'REMOTE_MONGO_ERROR';if(wire)code='MONGO_SERVER_VERSION';else if(/Authentication failed|auth failed/i.test(text)||error.code===18)code='AUTH_REQUIRED';else if(/not authorized|Unauthorized/i.test(text)||error.code===13)code='MONGO_READ_PERMISSION';else if(/ECONNREFUSED/.test(text))code='NETWORK_REFUSED';else if(/timed out|timeout|exceeded time limit|MaxTimeMSExpired/i.test(text)||error.code===50)code='MONGO_CONNECTION_TIMEOUT';return {code,...(wire?{serverWireVersion:Number(wire[1])}:{}),...(minimum?{minimumWireVersion:Number(minimum[1]??minimum[2])}:{})};}
const fail=code=>{throw Object.assign(new Error(),{code});};
const field=s=>typeof s==='string'&&/^[\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_][\p{L}\p{N}_-]*)*$/u.test(s)&&!sensitive.test(s)&&!s.startsWith('__mongo_')&&!s.split('.').some(x=>['__proto__','prototype','constructor'].includes(x));
const collection=s=>typeof s==='string'&&/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(s)&&!s.startsWith('system.')&&!sensitive.test(s);
function permitted(name,patterns){return collection(name)&&patterns.some(p=>p.endsWith('*')?name.startsWith(p.slice(0,-1)):name===p);}
function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return false;const [y,m,d,h,min,sec]=value.slice(0,19).split(/[-T:]/).map(Number),test=new Date(Date.UTC(y,m-1,d,h,min,sec));return test.getUTCFullYear()===y&&test.getUTCMonth()===m-1&&test.getUTCDate()===d&&h<24&&min<60&&sec<60;}
function scalar(value,type){
 if(type==='string'&&typeof value==='string')return value;
 if(type==='boolean'&&typeof value==='boolean')return value;
 if(type==='int64'&&typeof value==='string'&&/^-?\d+$/.test(value)){const n=BigInt(value);if(n>=-(2n**63n)&&n<2n**63n)return Long.fromString(value);}
 if(type==='decimal'&&typeof value==='string'&&/^[-+]?\d+(?:\.\d+)?$/.test(value))return Decimal128.fromString(value);
 if(type==='objectId'&&typeof value==='string'&&/^[a-f0-9]{24}$/i.test(value))return new ObjectId(value);
 if(type==='date'&&validDate(value))return new Date(value);
 fail('MONGO_VALUE_TYPE');
}
function filters(items){
 if(!Array.isArray(items))fail('MONGO_FILTERS');const and=[];
 for(const f of items){if(!f||!field(f.column)||Object.keys(f).some(k=>!['column','op','value','type'].includes(k)))fail('MONGO_FILTERS');
 if(f.op==='is_null'){and.push({[f.column]:{$type:'null'}});continue;}if(f.op==='is_missing'){and.push({[f.column]:{$exists:false}});continue;}if(f.op==='is_not_null'){and.push({[f.column]:{$exists:true,$ne:null}});continue;}
 const ops={'=':'$eq','>':'$gt','>=':'$gte','<':'$lt','<=':'$lte',in:'$in'};if(!ops[f.op])fail('MONGO_FILTERS');
 if(f.op==='in'&&(!Array.isArray(f.value)||!f.value.length))fail('MONGO_FILTERS');and.push({[f.column]:{[ops[f.op]]:f.op==='in'?f.value.map(v=>scalar(v,f.type)):scalar(f.value,f.type)}});
 }return and.length?{$and:and}:{};
}
function normalize(value){
 if(value===undefined||value===null)return null;if(value instanceof Date)return value.toISOString();if(value instanceof ObjectId||Long.isLong(value)||value instanceof Decimal128)return value.toString();
 if(typeof value==='number'){if(!Number.isFinite(value))fail('MONGO_NONFINITE');if(Number.isInteger(value)&&!Number.isSafeInteger(value))fail('MONGO_INTEGER_PRECISION');return String(value);}if(typeof value==='boolean')return value?'true':'false';if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(normalize);if(typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!sensitive.test(k)).map(([k,v])=>[k,normalize(v)]));fail('MONGO_VALUE_TYPE');
}
function validateArgs(a,patterns){
 if(!a||!Array.isArray(a.collections)||!a.collections.length||new Set(a.collections).size!==a.collections.length||a.collections.some(c=>!permitted(c,patterns)))fail('MONGO_COLLECTION_SCOPE');
 if(Object.keys(a).some(k=>!['collections','columns','filters','groupColumns','aggregates'].includes(k)))fail('MONGO_ARGUMENTS');filters(a.filters??[]);
}
function pipeline(a){
 const match=filters(a.filters??[]),stages=[{$match:match}];for(const name of a.collections.slice(1))stages.push({$unionWith:{coll:name,pipeline:[{$match:match}]}});
 if(a.aggregates){if(!Array.isArray(a.groupColumns)||a.groupColumns.some(c=>!field(c))||new Set(a.groupColumns).size!==a.groupColumns.length||!Array.isArray(a.aggregates)||!a.aggregates.length)fail('MONGO_AGGREGATE');
 const used=new Set(a.groupColumns);const distinct=a.aggregates.filter(x=>x.op==='count_distinct');if(distinct.length&&(a.aggregates.length!==1||distinct.length!==1))fail('MONGO_DISTINCT_COMBINATION');
 for(const item of a.aggregates)if(!field(item.as)||item.as.includes('.')||used.has(item.as)||(used.add(item.as),false)||!['count','count_distinct','min','max','sum'].includes(item.op)||item.op!=='count'&&!field(item.column))fail('MONGO_AGGREGATE');
 const type=c=>({$cond:[{$in:[{$type:'$'+c},['double','int','long','decimal']]},'number',{$type:'$'+c}]});const id=Object.fromEntries(a.groupColumns.flatMap((c,i)=>[['k'+i,'$'+c],['t'+i,type(c)]]));
 if(distinct.length){stages.push({$match:{[distinct[0].column]:{$exists:true,$ne:null}}},{$group:{_id:{...id,v:'$'+distinct[0].column,vt:type(distinct[0].column)}}},{$project:{_id:0,...Object.fromEntries(a.groupColumns.map((c,i)=>[c,'$_id.k'+i])),__mongo_group_types:a.groupColumns.map((c,i)=>'$_id.t'+i),__mongo_distinct:'$_id.v',__mongo_distinct_type:'$_id.vt'}});return stages;}
 else {const group={_id:id};for(const item of a.aggregates){group[item.as]={[{count:'$sum',min:'$min',max:'$max',sum:'$sum'}[item.op]]:item.op==='count'?1:'$'+item.column};if(item.op!=='count')group[item.as+'__types']={$addToSet:{$type:'$'+item.column}};if(item.op==='sum')group[item.as+'__null_count']={$sum:{$cond:[{$eq:[{$ifNull:['$'+item.column,null]},null]},1,0]}};}stages.push({$group:group});}
 stages.push({$project:{_id:0,...Object.fromEntries(a.groupColumns.map((c,i)=>[c,'$_id.k'+i])),__mongo_group_types:a.groupColumns.map((c,i)=>'$_id.t'+i),...Object.fromEntries(a.aggregates.flatMap(item=>[[item.as,1],...(item.op==='sum'?[[item.as+'__null_count',1]]:[]),...(item.op!=='count'?[[item.as+'__types',1]]:[])]))}});if(a.groupColumns.length)stages.push({$sort:Object.fromEntries(a.groupColumns.map(c=>[c,1]))});
 }else {if(!Array.isArray(a.columns)||!a.columns.length||new Set(a.columns).size!==a.columns.length||a.columns.some(c=>!field(c)))fail('MONGO_FIELDS');stages.push({$project:{_id:1,...Object.fromEntries(a.columns.map(c=>[c,1]))}});}
 return stages;
}
function checkPrivileges(info,mode){
 const status=info?.authInfo;if(!status?.authenticatedUsers?.length||!Array.isArray(status.authenticatedUserPrivileges))fail('MONGO_ACCOUNT_UNVERIFIED');
 const readonly=new Set(['find','listCollections','listIndexes','collStats','dbStats','indexStats','killCursors','changeStream','listSearchIndexes','planCacheRead']);
 const actions=[...new Set(status.authenticatedUserPrivileges.flatMap(p=>p.actions??[]))];if(!actions.includes('find'))fail('MONGO_READ_PERMISSION');if(mode!=='business-readonly'&&actions.some(x=>!readonly.has(x)))fail('MONGO_ACCOUNT_HAS_WRITE_PRIVILEGES');return {accountPolicy:mode,readPrivilege:true,writePrivilegePresent:actions.some(x=>!readonly.has(x))};
}
async function main(){
 let client,db,scope,queue=Promise.resolve();const cursors=new Map(),readline=require('node:readline'),rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
 async function page(token){const x=cursors.get(token);if(!x)fail('MONGO_CURSOR');const rows=[];for(let i=0;i<500&&await x.cursor.hasNext();i++){const row=await x.cursor.next();for(const item of x.args.aggregates??[])if(item.op==='sum'){if(Number(row[item.as+'__null_count']??0)>0)fail('MONGO_NULL_AMOUNT');if((row[item.as+'__types']??[]).some(t=>!['double','int','long','decimal'].includes(t)))fail('MONGO_AMOUNT_TYPE');}rows.push(normalize(row));}const complete=!await x.cursor.hasNext();if(complete){await x.cursor.close();cursors.delete(token);}return {rows,complete,nextCursor:complete?null:token};}
 rl.on('line',line=>{queue=queue.then(async()=>{let x;try{x=JSON.parse(line);if(!db){const c=x.connection;if(!c||!Array.isArray(c.collections)||!c.collections.length)fail('MONGO_CONNECTION_CONFIG');scope=c;client=new MongoClient('mongodb://'+c.host+':'+c.port,{auth:{username:c.username,password:c.password},authSource:c.authSource,tls:c.tls===true,connectTimeoutMS:c.timeoutMs,serverSelectionTimeoutMS:c.timeoutMs,socketTimeoutMS:c.timeoutMs,retryReads:false,retryWrites:false,directConnection:true,readPreference:'primary',promoteLongs:false});await client.connect();db=client.db(c.database);const info=await db.command({connectionStatus:1,showPrivileges:true});checkPrivileges(info,c.accountPolicy);send({id:x.id,ok:true,rows:{connected:true}});return;}
 const a=x.args??{},timeout=x.timeout;if(!Number.isSafeInteger(timeout)||timeout<100)fail('MONGO_TIMEOUT');let result;
 if(x.op==='connection'){let hello;try{hello=await db.command({hello:1});}catch(error){if(error.code!==59)throw error;hello=await db.command({isMaster:1});}const policy=checkPrivileges(await db.command({connectionStatus:1,showPrivileges:true}),scope.accountPolicy);result={...policy,serverTime:normalize(hello.localTime),maxWireVersion:hello.maxWireVersion,transport:'ssh-remote-execution',readConcern:scope.readConcern??'local',sameTransactionSnapshot:false};}
 else if(x.op==='collections'){const list=await db.listCollections({},{nameOnly:true,authorizedCollections:true,maxTimeMS:timeout}).toArray();result={collections:list.map(x=>x.name).filter(n=>permitted(n,scope.collections)).sort(),complete:true};}
 else if(x.op==='cursor_next')result=await page(a.cursor);else if(x.op==='cursor_close'){const item=cursors.get(a.cursor);if(!item)fail('MONGO_CURSOR');await item.cursor.close();cursors.delete(a.cursor);result={closed:true};}
 else{validateArgs(a,scope.collections);const names=new Set((await db.listCollections({},{nameOnly:true,authorizedCollections:true,maxTimeMS:timeout}).toArray()).map(x=>x.name));if(a.collections.some(c=>!names.has(c)))fail('MONGO_COLLECTION_MISSING');const col=db.collection(a.collections[0]);
 if(x.op==='indexes'){if(a.collections.length!==1)fail('MONGO_ARGUMENTS');result={indexes:normalize(await col.listIndexes({maxTimeMS:timeout}).toArray())};}
 else if(x.op==='schema'){if(a.collections.length!==1)fail('MONGO_ARGUMENTS');const rows=await col.aggregate([{$limit:100},{$project:{fields:{$objectToArray:'$$ROOT'}}},{$unwind:'$fields'},{$group:{_id:{name:'$fields.k',type:{$type:'$fields.v'}},sampleCount:{$sum:1}}}],{maxTimeMS:timeout}).toArray();result={fields:rows.filter(x=>field(x._id.name)).map(x=>({name:x._id.name,type:x._id.type,sampleCount:normalize(x.sampleCount)})),sampled:true,sampleLimit:100,schemaComplete:false};}
 else if(x.op==='explain'){result={plan:normalize(await col.aggregate(pipeline(a),{maxTimeMS:timeout,allowDiskUse:true,readConcern:{level:scope.readConcern??'local'}}).explain('queryPlanner')),businessQueryExecuted:false};}
 else if(x.op==='read'){const typeAudits=[];for(const column of [...new Set((a.filters??[]).filter(f=>f.type==='date').map(f=>f.column))]){const base=filters(a.filters.filter(f=>f.column!==column)),types=await col.aggregate([{$match:base},{$group:{_id:{$type:'$'+column},n:{$sum:1}}}],{maxTimeMS:timeout,readConcern:{level:scope.readConcern??'local'}}).toArray();if(types.some(t=>t._id!=='date'))fail('MONGO_DATE_TYPE_AMBIGUOUS');typeAudits.push({column,types:normalize(types),checkedAt:new Date().toISOString()});}const cursor=col.aggregate(pipeline(a),{maxTimeMS:timeout,batchSize:500,allowDiskUse:true,readConcern:{level:scope.readConcern??'local'}});const token=randomUUID();cursors.set(token,{cursor,args:a});result={...await page(token),typeAudits};}
 else fail('MONGO_READONLY_OPERATION');}
 const reply={id:x.id,ok:true,rows:result};if(Buffer.byteLength(JSON.stringify(reply))>24000000)fail('REMOTE_PAGE_TOO_LARGE');send(reply);
 }catch(error){send({id:x?.id,ok:false,...diagnostics(error),errno:Number.isInteger(error.code)?error.code:undefined});}});});
 rl.on('close',()=>queue.finally(async()=>{for(const x of cursors.values())await x.cursor.close().catch(()=>{});await client?.close();}));process.on('SIGTERM',()=>{client?.close().finally(()=>process.exit(0));});
}
module.exports={field,permitted,scalar,filters,pipeline,normalize,validateArgs,checkPrivileges};if(require.main===module)main();
