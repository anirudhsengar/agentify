import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSourceLocalReview} from './source-local-review.mjs';
const data={claims:{'invariants[0]':{rule:'Cache is absent.',reference:'cache.py'},'flows[0]':{steps:[{path:'entry.py',what_happens:'calls'},{path:'cache.py',what_happens:'returns'}]},validation:[]},evidence:{'entry.py':'def run(x):\n    return cache(x)\n','cache.py':'# Unicode λ\nvalue = None\n'},compiler_attachments:[]};
test('source-local review keeps exact source bytes, original IDs and empty obligations',()=>{
 const text=renderSourceLocalReview(data);
 for(const [file,source] of Object.entries(data.evidence)){
  assert.ok(text.includes(JSON.stringify(file)));
  assert.ok(text.includes(source.split('\n').map((line,i)=>String(i+1).padStart(5,'0')+'|'+line).join('\n')));
 }
 for(const id of Object.keys(data.claims))assert.ok(text.includes('"original_id": "'+id+'"'));
 for(const code of ['C000','C001','C002'])assert.ok(text.includes(code));
 assert.ok(text.includes('"assertion": []'));
});
test('each source-dependent assertion is repeated adjacent to its first referenced source without inventing text',()=>{
 const text=renderSourceLocalReview(data);
 const cacheBlock=text.slice(text.indexOf('IMMUTABLE UNTRUSTED SOURCE S1'));
 assert.ok(cacheBlock.includes('"rule": "Cache is absent."'));
 assert.ok(cacheBlock.includes('"C000"'));
 assert.ok(text.includes('"what_happens": "calls"'));
 assert.ok(text.includes('"what_happens": "returns"'));
});
