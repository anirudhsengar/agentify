import assert from 'node:assert/strict';
export function supportParameters(parameters) {
 return {...parameters,properties:{...parameters.properties,support_evidence:{type:'array',maxItems:512,
  description:'For supported, provide one source-backed justification for every assigned claim ID, including every clause and condition. For unsupported, omit this field and supply the decisive source finding.',
  items:{type:'object',properties:{claim:structuredClone(parameters.properties.checked_claims.items),path:{type:'string'},
   excerpt:{type:'string',minLength:1,maxLength:1024},reason:{type:'string',minLength:1,maxLength:512,
    description:'Explain why the exact source supports the whole claim, not just one clause. Check its conditional and quantified statements against a counterexample state.'}},
   required:['claim','path','excerpt','reason'],additionalProperties:false}}}};
}
export function validateSupport(report,data) {
 if(report.verdict!=='supported')return;
 assert.ok(Array.isArray(report.support_evidence),'Supported verdict requires source evidence for every assigned claim.');
 const ids=Object.keys(data.claims);assert.equal(report.support_evidence.length,ids.length,'Every assigned ID needs its own supporting evidence.');
 const seen=new Set();
 for(const proof of report.support_evidence){
  assert.ok(ids.includes(proof.claim)&&!seen.has(proof.claim),'Support IDs must be known, complete and unique.');seen.add(proof.claim);
  assert.ok(typeof proof.reason==='string'&&proof.reason.trim()&&proof.reason.length<=512,'Whole-claim support reason required.');
  const source=data.evidence[proof.path];assert.ok(typeof source==='string','Support path must be supplied immutable source.');
  assert.ok(typeof proof.excerpt==='string'&&proof.excerpt.trim()&&proof.excerpt.length<=1024,'Support quote must be bounded and nonempty.');
  const margins=[...new Set(source.split('\n').map(line=>/^[ \t]+/.exec(line)?.[0]).filter(Boolean))];
  assert.ok(source.includes(proof.excerpt)||margins.some(margin=>source.includes(proof.excerpt.split('\n').map(line=>margin+line).join('\n'))),'Support quote must match exact source bytes.');
 }
}
