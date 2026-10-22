// Runs on the approved SSH server. Credentials arrive on stdin only.
const readline=require('node:readline');
const mysql=require('mysql2/promise');
let conn,initialized=false,queue=Promise.resolve();
function allowed(sql){
 if(typeof sql!=='string'||sql.length>100000||/;|--|\/\*|\b(?:INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|LOCK|SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK)\b/i.test(sql))return false;
 return /^(?:SELECT\s|SHOW\s(?:GRANTS|TABLES|COLUMNS|DATABASES|SESSION\s+(?:VARIABLES|STATUS))\b|SET SESSION MAX_EXECUTION_TIME=\d+$|SET TRANSACTION ISOLATION LEVEL REPEATABLE READ$|START TRANSACTION READ ONLY$|ROLLBACK$)/i.test(sql);
}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',line=>{queue=queue.then(async()=>{
 let x;try{x=JSON.parse(line);if(!initialized){
  initialized=true;const c=x.connection;
  conn=await mysql.createConnection({...c,multipleStatements:false,enableCleartextPlugin:false,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true});
  send({id:x.id,ok:true});return;
 }
 if(!allowed(x.sql)||!Array.isArray(x.params))throw Object.assign(new Error(),{code:'REMOTE_READONLY_SQL'});
 const result=x.method==='execute'?await conn.execute({sql:x.sql,timeout:x.timeout},x.params):await conn.query({sql:x.sql,timeout:x.timeout},x.params);
 const reply={id:x.id,ok:true,rows:result[0]};if(Buffer.byteLength(JSON.stringify(reply))>24000000)send({id:x.id,ok:false,code:'REMOTE_PAGE_TOO_LARGE'});else send(reply);
 }catch(e){send({id:x?.id,ok:false,code:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'REMOTE_MYSQL_ERROR',errno:e.errno,sqlState:e.sqlState});}
 });});
rl.on('close',()=>{queue.finally(async()=>{if(conn){try{await conn.rollback();}catch{}conn.destroy();}});});
process.on('SIGTERM',()=>{conn?.destroy();process.exit(0);});
