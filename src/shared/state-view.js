// Select trusted internal fields before cloning. Never expose the cached root to callers.
export async function stateView(store, select) {
 return store.select ? store.select(select) : select(await store.read());
}

// Projection only, never authorization: callers still verify sender/profile/project,
// generation and file scope. Include ancestors for delivered-file follow-ups.
export function questionSlice(state,record){
 const ids=new Set();let q=record.questionPreview??state.questions?.[record.questionId??(state.jobs??[]).find(j=>j.id===record.id)?.questionId];
 while(q&&!ids.has(q.id)){ids.add(q.id);q=state.questions?.[q.parentQuestionId];}
 if(record.questionId)ids.add(record.questionId);
 const jobs=(state.jobs??[]).filter(j=>ids.size?ids.has(j.questionId)||j.id===record.id:(!record.chatId||j.chatId===record.chatId)&&(!record.projectId||j.projectId===record.projectId));
 const jobIds=new Set(jobs.map(j=>j.id));
 return {jobs,questions:state.questions??{},conversations:(state.conversations??[]).filter(t=>ids.size?ids.has(t.questionId)||t.id===record.id:(!record.chatId||t.chatId===record.chatId)),
 reportDeliveries:Object.fromEntries(Object.entries(state.reportDeliveries??{}).filter(([,e])=>jobIds.has(e.sourceJobId))),
 environmentEnrollments:Object.fromEntries(Object.entries(state.environmentEnrollments??{}).filter(([,e])=>!ids.size||ids.has(e.questionId))),ownerPresence:state.ownerPresence};
}
export const questionStateView=(store,record)=>stateView(store,s=>questionSlice(s,record));
