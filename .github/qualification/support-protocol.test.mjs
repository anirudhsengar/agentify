import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewReport,materializeCitation,supportParameters} from './support-protocol.mjs';
const data={claims:{a:'Convert input.',b:'Return conversion.',validation:[]},evidence:{'x.py':'def f(x):\n    return int(x)\n'}};
const proof={source:0,start_line:2,end_line:2,reason:'Return int(x).'};
test('complete claim-keyed approval is an explicit complete checklist',()=>{
 assert.deepEqual(normalizeReviewReport({verdict:'supported',support:{a:proof,b:proof,validation:true}},data),{verdict:'supported',checked_claims:['a','b','validation']});
});
test('missing, foreign, duplicate-list and absent empty acknowledgments cannot approve',()=>{
 for(const support of [undefined,[],[proof,proof],{a:proof},{a:proof,b:proof},{a:proof,b:proof,validation:false},{a:proof,b:proof,validation:true,unknown:proof}])
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
 assert.throws(()=>normalizeReviewReport({verdict:'unsupported',finding:{...p,claim:'a'}},large));
 assert.doesNotThrow(()=>normalizeReviewReport({verdict:'supported',support:{a:p}},large));
});
test('contradictory verdicts and missing negative findings fail closed',()=>{
 for(const r of [{verdict:'supported',finding:{...proof,claim:'a'},support:{a:proof,b:proof,validation:true}},
  {verdict:'unsupported'},{verdict:'unsupported',support:{},finding:{...proof,claim:'a'}},{verdict:'unknown'}])assert.throws(()=>normalizeReviewReport(r,data));
});
test('canonical rejection still carries exact source and original claim ID',()=>{
 const r=normalizeReviewReport({verdict:'unsupported',finding:{...proof,claim:'a'}},data);
 assert.deepEqual(r,{verdict:'unsupported',checked_claims:[],finding:{claim:'a',path:'x.py',excerpt:'    return int(x)',reason:'Return int(x).'}});
});
