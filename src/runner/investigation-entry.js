// Selection only: actual environment scope/lease/credential validation stays in
// executeEnvironmentJob. Never migrate an existing legacy model thread.
export const nativeInvestigationEngine='native-tools-v1';
export function useNativeInvestigation(job,config,legacyThreadId) {
 if(job.taskIntent!=='analysis'||!job.continuousInvestigation||job.stage!=='developer')return false;
 if(job.analysisContinuation?.executionEngine===nativeInvestigationEngine)return true;
 return config.analysisEngine===nativeInvestigationEngine&&!legacyThreadId;
}
export function nativeGrantedEntry(job,config) {
 if(!job.environmentAccess)return false;
 const sourceThread=job.sourceEnvironmentThreads?.[job.sourceEnvironment];
 const prior=job.analysisContinuation?.threadId??job.modelCheckpoint?.threadId
  ??[...(job.context??[])].reverse().find(e=>e.stage==='developer'&&e.result?.threadId
    &&(!e.result.sourceQuestionId||e.result.sourceQuestionId===job.questionId))?.result.threadId
  ??(sourceThread&&sourceThread.questionId===job.questionId?sourceThread.threadId:null);
 return useNativeInvestigation(job,config,prior);
}
