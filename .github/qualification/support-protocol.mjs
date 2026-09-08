import assert from 'node:assert/strict';
const empty=value=>Array.isArray(value)&&value.length===0;
export const evidenceClaimIds=data=>Object.entries(data.claims).filter(([,value])=>!empty(value)).map(([id])=>id);
function citationSchema(data,negative=false){
 return {type:'object',properties:{source:{type:'integer',enum:Object.keys(data.evidence).map((_,index)=>index)},
  start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1},
  reason:{type:'string',minLength:1,maxLength:1024,description:negative
   ? 'Why this exact source contradicts or fails to establish the whole assertion. Do not confuse a return value with a predicate result.'
   : 'Briefly justify every clause. Before claiming support, evaluate any compound condition on empty, missing, disabled and boundary-value inputs.'}},
  required:['source','start_line','end_line','reason'],additionalProperties:false};
}
export function supportParameters(parameters,data){
 const negative=citationSchema(data,true);
 const finding={...negative,properties:{claim:structuredClone(parameters.properties.checked_claims.items),...negative.properties},
  required:['claim',...negative.required]};
 const support={type:'object',properties:Object.fromEntries(Object.entries(data.claims).map(([id,value])=>[id,empty(value)
   ? {const:true,description:'Explicitly acknowledge the supplied empty collection; no command or evidence is inferred.'}
   : citationSchema(data)])),required:Object.keys(data.claims),additionalProperties:false,
  description:'Required only for supported: every named property must justify its entire claim. Empty collections use literal true. For unsupported omit support and provide one decisive source finding.'};
 return {type:'object',properties:{verdict:structuredClone(parameters.properties.verdict),support,finding,
  additional_findings:{type:'array',items:finding,maxItems:2}},required:['verdict'],additionalProperties:false};
}
export function materializeCitation(proof,data,maxCharacters=1024){
 assert.ok(proof&&Number.isInteger(proof.source)&&proof.source>=0,'Known source ID required.');
 const files=Object.keys(data.evidence);const path=files[proof.source];assert.ok(path!==undefined,'Source ID is outside supplied evidence.');
 const lines=data.evidence[path].split('\n');
 assert.ok(Number.isInteger(proof.start_line)&&Number.isInteger(proof.end_line)&&proof.start_line>=1
  &&proof.end_line>=proof.start_line&&proof.end_line<=lines.length,'Source line interval is invalid.');
 const excerpt=lines.slice(proof.start_line-1,proof.end_line).join('\n');
 assert.ok(excerpt.trim().length>0&&excerpt.length<=maxCharacters,'Source span is empty or exceeds its character limit.');
 assert.ok(typeof proof.reason==='string'&&proof.reason.trim()&&proof.reason.length<=1024,'Source finding requires a bounded reason.');
 return {claim:proof.claim,path,excerpt,reason:proof.reason};
}
export function normalizeReviewReport(report,data){
 assert.ok(report&&['supported','unsupported'].includes(report.verdict),'Explicit supported/unsupported verdict required.');
 if(report.verdict==='supported'){
  assert.ok(report.finding===undefined&&(!report.additional_findings||report.additional_findings.length===0),'Approval cannot contain a source finding.');
  const ids=Object.keys(data.claims);const support=report.support;
  assert.ok(support&&typeof support==='object'&&!Array.isArray(support),'Supported verdict requires the claim-keyed proof map.');
  assert.deepEqual(Object.keys(support).sort(),[...ids].sort(),'Every assigned claim, including empty collections, needs an explicit entry.');
  for(const id of ids){
   if(empty(data.claims[id]))assert.equal(support[id],true,'Empty-collection acknowledgment must be literal true.');
   else materializeCitation({...support[id],claim:id},data,512*1024);
  }
  // Keys are validated, explicit proof acknowledgments, not fabricated checks.
  // The original full-checklist validator still verifies these exact IDs.
  return {verdict:'supported',checked_claims:ids};
 }
 assert.equal(report.support,undefined,'A rejection cannot simultaneously approve claims.');
 assert.ok(report.finding,'Unsupported verdict requires an immutable-source finding.');
 return {verdict:'unsupported',checked_claims:[],finding:materializeCitation(report.finding,data),
  ...(report.additional_findings!==undefined?{additional_findings:report.additional_findings.map(x=>materializeCitation(x,data))}:{})};
}
