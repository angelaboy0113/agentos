import {queryEvidenceIdentity} from './query-evidence.js';
const bad=m=>{throw Object.assign(new Error(m),{code:'REPORT_INPUT'});};

export function deploymentTimestamp(value,{offset,timestampUnit}={}){
 if(timestampUnit){
  if(!['seconds','milliseconds'].includes(timestampUnit)||!/^\-?\d+$/.test(String(value))||!Number.isSafeInteger(Number(value)))bad('部署时间戳需要明确seconds/milliseconds及安全整数');
  const ms=Number(value)*(timestampUnit==='seconds'?1000:1),date=new Date(ms);
  if(!Number.isSafeInteger(ms)||!Number.isFinite(+date))bad('部署时间戳无效');return date.toISOString();
 }
 if(typeof value!=='string')bad('部署时间的数值单位或时区不明确');
 const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})?$/.exec(value);
 if(!match)bad('部署时间需要实际日期、时分秒及明确时区；日期或提交时间不能替代上线时间');
 const zone=match[3]??offset;if(!zone||! /^(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(zone)||/^[+-]14:(?!00)/.test(zone))bad('部署时间缺少明确时区偏移；不猜测本机时区或夏令时');
 const local=new Date(match[1]+'T'+match[2]+'Z');
 if(!Number.isFinite(+local)||local.getUTCFullYear()<1||local.toISOString().slice(0,19)!==(match[1]+'T'+match[2]).slice(0,19))bad('部署时间日期不存在');
 const date=new Date(match[1]+'T'+match[2]+zone);if(!Number.isFinite(+date))bad('部署时间无效');return date.toISOString();
}

// Consumes an existing scoped, complete dataset. It does not scrape a platform,
// create a credential, query production, or turn Git times into deployments.
export function deploymentEvidence(args,data,scope={}){
 if(!scope.projectId||!scope.environment)bad('部署取证缺少可信任务系统与环境绑定');
 if(!data?.complete||data.reportDraft||!queryEvidenceIdentity(data))bad('部署证据需要本任务已登记的完整原始发布记录数据集');
 const c=args.columns??{},needed=['system','environment','application','deployedAt','status'];
 if(needed.some(k=>!data.columns.includes(c[k]))||(!data.columns.includes(c.commit)&&!data.columns.includes(c.build)))bad('部署记录需要真实系统、环境、应用、状态、部署时间及提交或构建号列');
 if(typeof args.application!=='string'||!args.application.trim()||!Array.isArray(args.successValues)||!args.successValues.length||args.successValues.some(v=>typeof v!=='string'||!v)||typeof args.evidence!=='string'||args.evidence.trim().length<3)bad('必须说明应用、真实成功状态字典及发布来源依据');
 if(args.offset&&!args.timezoneEvidence?.trim())bad('解释无时区部署时间需要已核实的timezoneEvidence');
 const records=[];let otherScopeRows=0,otherApplicationRows=0,unsuccessfulRows=0;
 for(const [index,row]of data.rows.entries()){
  if(String(row[c.system]).toLowerCase()!==scope.projectId.toLowerCase()||String(row[c.environment]).toLowerCase()!==scope.environment.toLowerCase()){otherScopeRows++;continue;}
  if(row[c.application]!==args.application){otherApplicationRows++;continue;}
  if(!args.successValues.includes(row[c.status])){unsuccessfulRows++;continue;}
  const deployedAt=deploymentTimestamp(row[c.deployedAt],args),commit=c.commit?row[c.commit]:null,build=c.build?row[c.build]:null;
  if(commit&&!/^[a-f0-9]{7,64}$/i.test(commit)||!commit&&!build)bad('实际成功发布记录缺少可用提交或构建号');
  records.push({sourceRow:index+1,system:scope.projectId,environment:scope.environment,application:args.application,commit:commit??null,build:build??null,deployedAt});
 }
 return {policy:'scoped-deployment-records-v1',deploymentVerified:records.length>0,records,source:{datasetRef:args.datasetRef,queryIdentity:queryEvidenceIdentity(data),readAt:data.readAt,snapshotId:data.snapshotId,evidence:args.evidence,...(args.timezoneEvidence?{timezoneEvidence:args.timezoneEvidence}:{})},audit:{inputRows:data.rows.length,otherScopeRows,otherApplicationRows,unsuccessfulRows},note:records.length?'实际发布记录与系统/环境/应用、提交或构建号及部署时间建立对应；不据此推断最新生产实例仍运行该版本。':'未取得匹配的成功发布记录；不能用提交时间、文件时间或其他环境记录替代上线时间。'};
}
