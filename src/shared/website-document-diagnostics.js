import {websitePageLocation}from'./browser-tool-input.js';
// A blocked request on an earlier document must not look like a fresh failure
// after navigation or successful sign-in. Prior snapshots retain their evidence.
export function advanceWebsiteDocumentDiagnostics(state,url){
 if(!/^https?:\/\//.test(url??''))return;
 const previous=state.documentLocation,blockedRequests=[...(state.blocked??[])];
 if(previous&&blockedRequests.length){state.previousDocumentDiagnostics??=[];state.previousDocumentDiagnostics.push({location:previous,blockedRequests});state.previousDocumentDiagnostics=state.previousDocumentDiagnostics.slice(-8);}
 state.documentLocation=websitePageLocation(url);
 for(const key of ['blocked','blockedLoginReads','blockedResources','resourceFailures','pageErrors'])state[key]?.clear();
 state.blockedRequestDetails=[];
}
