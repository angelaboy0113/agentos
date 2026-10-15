import {lstat,realpath,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function reportFile(dataDir,jobId,item){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)||!/^report-[a-f0-9-]{36}$/.test(item?.id??'')||item.filename!==item.id+'.csv'||item.complete!==true||!Number.isInteger(item.rowCount)||item.rowCount<0||item.rowCount>10000||!Number.isInteger(item.bytes)||item.bytes<1||item.bytes>10_000_000||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw new Error('报表文件登记信息无效');
 const root=await realpath(path.join(dataDir,'exports')),file=path.join(dataDir,'exports',jobId,item.filename);
 const jobRoot=path.join(dataDir,'exports',jobId),jobInfo=await lstat(jobRoot),jobActual=await realpath(jobRoot);
 if(jobInfo.isSymbolicLink()||!jobActual.startsWith(root+path.sep))throw new Error('报表任务目录无效');
 const info=await lstat(file),actual=await realpath(file);
 if(!info.isFile()||info.isSymbolicLink()||!actual.startsWith(jobActual+path.sep)||info.size!==item.bytes)throw new Error('报表文件不在任务输出目录或大小不符');
 const content=await readFile(file);if(createHash('sha256').update(content).digest('hex')!==item.sha256)throw new Error('报表文件校验失败');
 if(!/^[a-f0-9]{64}$/.test(item.verificationHash??''))throw new Error('报表尚未通过最终核验，不能作为正式文件交付');
 const receiptPath=path.join(path.dirname(actual),item.id+'.verification.json'),receiptInfo=await lstat(receiptPath);
 if(!receiptInfo.isFile()||receiptInfo.isSymbolicLink()||receiptInfo.size>64000)throw new Error('报表核验记录无效');
 const body=await readFile(receiptPath);if(createHash('sha256').update(body).digest('hex')!==item.verificationHash)throw new Error('报表核验记录摘要不符');
 const receipt=JSON.parse(body.toString());
 if(receipt.version!==1||receipt.status!=='verified'||receipt.file?.sha256!==item.sha256||receipt.file?.id!==item.id||receipt.coverage?.rowCount!==item.rowCount)throw new Error('报表核验记录与文件不符');
 return {file:actual,content};
}
export async function validateReportFiles(dataDir,jobId,files){
 if(files===undefined)return [];
 if(!Array.isArray(files)||files.length>4)throw new Error('单次最多登记4个报表文件');
 for(const item of files)await reportFile(dataDir,jobId,item);
 return files.map(({id,filename,bytes,sha256,rowCount,complete,verificationHash})=>({id,filename,bytes,sha256,rowCount,complete,verificationHash}));
}
