import assert from 'node:assert/strict';
const empty=value=>Array.isArray(value)&&value.length===0;
export const evidenceClaimIds=data=>Object.entries(data.claims).filter(([,value])=>!empty(value)).map(([id])=>id);
export function supportParameters(parameters,data) {
 const files=Object.keys(data.evidence);
 const fields={source:{type:'integer',enum:files.map((_,index)=>index),description:'Exact S<number> immutable source identifier.'},
  start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1},
  reason:{type:'string',minLength:1,maxLength:1024,description:'Explain the entire assertion, including its conditions. Source line numbers are inclusive and one-based.'}};
 const finding={type:'object',properties:{claim:structuredClone(parameters.properties.checked_claims.items),...fields},
  required:['claim','source','start_line','end_line','reason'],additionalProperties:false};
 return {...parameters,properties:{...parameters.properties,finding,
  additional_findings:{type:'array',items:finding,maxItems:2},
  support_evidence:{type:'array',maxItems:512,description:'For supported, one exact-source justification for every nonempty assigned claim. Empty collections need no invented source proof but remain in checked_claims. Omit for unsupported.',
   items:{...finding,properties:{...finding.properties,claim:{type:'string',enum:evidenceClaimIds(data)},
    reason:{type:'string',minLength:1,maxLength:256,description:'One short explanation supporting every clause, not merely part of the assertion.'}}}}}};
}
export function materializeCitation(proof,data) {
 assert.ok(proof&&Number.isInteger(proof.source)&&proof.source>=0,'Known source ID required.');
 const files=Object.keys(data.evidence);const path=files[proof.source];assert.ok(path!==undefined,'Source ID is outside supplied evidence.');
 const lines=data.evidence[path].split('\n');
 assert.ok(Number.isInteger(proof.start_line)&&Number.isInteger(proof.end_line)&&proof.start_line>=1
  &&proof.end_line>=proof.start_line&&proof.end_line<=lines.length,'Source line interval is invalid.');
 const excerpt=lines.slice(proof.start_line-1,proof.end_line).join('\n');
 assert.ok(excerpt.trim().length>0&&excerpt.length<=1024,'Choose a nonempty source span of at most 1024 characters.');
 assert.ok(typeof proof.reason==='string'&&proof.reason.trim()&&proof.reason.length<=1024,'Source finding requires a bounded reason.');
 return {claim:proof.claim,path,excerpt,reason:proof.reason};
}
export function normalizeReviewReport(report,data) {
 const {support_evidence,finding,additional_findings,...rest}=report;
 if(report.verdict==='supported') {
  const ids=evidenceClaimIds(data);assert.ok(Array.isArray(support_evidence)&&support_evidence.length===ids.length,'Every nonempty assigned ID needs one source justification.');
  const seen=new Set();
  for(const proof of support_evidence){
   assert.ok(ids.includes(proof.claim)&&!seen.has(proof.claim),'Support IDs must be known, complete and unique.');seen.add(proof.claim);
   materializeCitation(proof,data);assert.ok(proof.reason.length<=256,'Keep positive justification within 256 characters.');
  }
 }
 return {...rest,...(finding!==undefined?{finding:materializeCitation(finding,data)}:{}),
  ...(additional_findings!==undefined?{additional_findings:additional_findings.map(item=>materializeCitation(item,data))}:{})};
}
