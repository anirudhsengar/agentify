import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewReport,materializeCitation} from './support-protocol.mjs';
const data={claims:{a:'Convert the input.',b:'Return its integer value.',validation:[]},evidence:{'x.py':'def f(x):\n    return int(x)\n'}};
const proof=claim=>({claim,source:0,start_line:2,end_line:2,reason:'The function returns int(x).'});
test('complete justified approvals retain the original full checklist',()=>{
 const r=normalizeReviewReport({verdict:'supported',checked_claims:['a','b','validation'],support_evidence:[proof('a'),proof('b')]},data);
 assert.deepEqual(r,{verdict:'supported',checked_claims:['a','b','validation']});
});
test('missing, duplicate and foreign support IDs never approve',()=>{
 for(const support_evidence of [undefined,[],[proof('a')],[proof('a'),proof('a')],[proof('a'),proof('unknown')]])
  assert.throws(()=>normalizeReviewReport({verdict:'supported',support_evidence},data));
});
test('immutable positions reconstruct exact bytes, not model-authored quotes',()=>{
 assert.deepEqual(materializeCitation(proof('a'),data),{claim:'a',path:'x.py',excerpt:'    return int(x)',reason:'The function returns int(x).'});
 for(const change of [{source:-1},{source:1},{source:0.5},{start_line:0},{start_line:3,end_line:2},{end_line:4},{start_line:3,end_line:3},{reason:''}])
  assert.throws(()=>materializeCitation({...proof('a'),...change},data));
});
test('oversized spans fail rather than being truncated',()=>{
 assert.throws(()=>materializeCitation({...proof('a'),start_line:1,end_line:1},{claims:data.claims,evidence:{'x.py':'x'.repeat(1025)}}));
});
test('rejections retain canonical source findings without positive-proof fabrication',()=>{
 const r=normalizeReviewReport({verdict:'unsupported',checked_claims:[],finding:proof('a')},data);
 assert.deepEqual(r.finding,materializeCitation(proof('a'),data));assert.ok(!('support_evidence' in r));
});
