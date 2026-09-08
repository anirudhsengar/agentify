import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewReport,materializeCitation,supportParameters,claimBindings} from './support-protocol.mjs';
const data={claims:{a:'Convert input.',b:'Return conversion.',validation:[]},evidence:{'x.py':'def f(x):\n    return int(x)\n'}};
const proof={source:0,start_line:2,end_line:2,reason:'Return int(x).'};
test('complete claim-keyed approval is an explicit complete checklist',()=>{
 assert.deepEqual(normalizeReviewReport({verdict:'supported',support:{C000:proof,C001:proof,C002:true}},data),{verdict:'supported',checked_claims:['a','b','validation']});
});
test('missing, foreign, duplicate-list and absent empty acknowledgments cannot approve',()=>{
 for(const support of [undefined,[],[proof,proof],{C000:proof},{C000:proof,C001:proof},{C000:proof,C001:proof,C002:false},{C000:proof,C001:proof,C002:true,C999:proof}])
  assert.throws(()=>normalizeReviewReport({verdict:'supported',support},data));
});
test('source indices and inclusive spans reconstruct exact immutable bytes',()=>{
 assert.equal(materializeCitation({...proof,claim:'a'},data).excerpt,'    return int(x)');
 for(const change of [{source:-1},{source:1},{source:0.5},{start_line:0},{start_line:3,end_line:2},{end_line:4},{start_line:3,end_line:3},{reason:''}])
  assert.throws(()=>materializeCitation({...proof,claim:'a',...change},data));
});
test('negative excerpts stay within original limit; positive references may cover a whole source scope',()=>{
 const large={claims:{a:'whole source'},evidence:{'x.py':'x'.repeat(1200)}};
 const p={...proof,start_line:1,end_line:1};
 assert.throws(()=>normalizeReviewReport({verdict:'unsupported',finding:{...p,claim:'C000'}},large));
 assert.doesNotThrow(()=>normalizeReviewReport({verdict:'supported',support:{C000:p}},large));
});
test('contradictory verdicts and missing negative findings fail closed',()=>{
 for(const r of [{verdict:'supported',finding:{...proof,claim:'C000'},support:{C000:proof,C001:proof,C002:true}},
  {verdict:'unsupported'},{verdict:'unsupported',support:{},finding:{...proof,claim:'C000'}},{verdict:'unknown'}])assert.throws(()=>normalizeReviewReport(r,data));
});
test('canonical rejection still carries exact source and original claim ID',()=>{
 const r=normalizeReviewReport({verdict:'unsupported',finding:{...proof,claim:'C000'}},data);
 assert.deepEqual(r,{verdict:'unsupported',checked_claims:[],finding:{claim:'a',path:'x.py',excerpt:'    return int(x)',reason:'Return int(x).'}});
});

test('opaque claim codes bind exactly to assigned original IDs',()=>{
 assert.deepEqual(claimBindings(data),{C000:'a',C001:'b',C002:'validation'});
 assert.throws(()=>normalizeReviewReport({verdict:'unsupported',finding:{...proof,claim:'a'}},data));
 assert.throws(()=>normalizeReviewReport({verdict:'unsupported',finding:{...proof,claim:'C999'}},data));
 const parameters={properties:{checked_claims:{items:{type:'string',enum:['a','b','validation']}},verdict:{type:'string',enum:['supported','unsupported']}}};
 const schema=supportParameters(parameters,data);
 assert.deepEqual(schema.properties.support.required,['C000','C001','C002']);
 assert.deepEqual(schema.properties.finding.properties.claim.enum,['C000','C001','C002']);
});
