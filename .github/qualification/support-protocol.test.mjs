import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSupport} from './support-protocol.mjs';
const data={claims:{a:'Normalize the caller input.',b:'Return converted input.'},evidence:{'x.py':'    def f(x):\n        return int(x)\n'}};
const proof=claim=>({claim,path:'x.py',excerpt:'return int(x)',reason:'The immutable function converts x to an integer.'});
test('complete unique source proofs support an otherwise approved assignment',()=>{
 assert.doesNotThrow(()=>validateSupport({verdict:'supported',support_evidence:[proof('a'),proof('b')]},data));
});
test('missing, duplicate and foreign support IDs cannot authorize approval',()=>{
 for(const report of [{verdict:'supported'},...[[],[proof('a')],[proof('a'),proof('a')],[proof('a'),proof('foreign')]].map(support_evidence=>({verdict:'supported',support_evidence}))])
  assert.throws(()=>validateSupport(report,data));
});
test('source proof paths and excerpt bytes are mandatory and exact',()=>{
 for(const invalid of [{path:'outside.py'},{excerpt:'return False'},{excerpt:''},{reason:''}])
  assert.throws(()=>validateSupport({verdict:'supported',support_evidence:[proof('a'),{...proof('b'),...invalid}]},data));
});
test('rejections need no invented positive proof; the original source-finding gate still executes',()=>{
 assert.doesNotThrow(()=>validateSupport({verdict:'unsupported'},data));
});
