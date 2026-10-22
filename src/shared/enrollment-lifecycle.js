// Shared lifecycle vocabulary for routing, presentation, recovery and process coordination.
export const ENROLLMENT_PENDING = Object.freeze(['requested','opening','login_required','scope_required','awaiting_tls_confirmation']);
export const ENROLLMENT_LIVE = Object.freeze(['opening','login_required','scope_required']);
export const isPendingEnrollment = e => ENROLLMENT_PENDING.includes(e?.status);
export const isLiveEnrollment = e => ENROLLMENT_LIVE.includes(e?.status);
export const sameEnrollmentScope = (e, target) => ['projectId','chatId','profile','questionId'].every(key => e?.[key] === target?.[key]);
