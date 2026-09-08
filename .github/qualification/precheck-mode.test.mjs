import assert from 'node:assert/strict';
import test from 'node:test';
import {configureLocalReview} from './precheck-mode.mjs';
const fixture=()=>({config:{schemaVersion:1,thinkingLevel:'high',models:{primary:{provider:'minimax',model:'MiniMax-M3'}}},userPrompt:JSON.stringify({source_precheck:true}),maxOutputTokens:4096,timeoutMs:90000});
test('only the bounded M3 local review changes thinking, never model, limits or caller config',()=>{
 const original=fixture();const snapshot=structuredClone(original);const next=configureLocalReview(original);
 assert.equal(next.config.thinkingLevel,'off');assert.equal(next.config.models,original.config.models);
 assert.equal(next.maxOutputTokens,original.maxOutputTokens);assert.equal(next.timeoutMs,original.timeoutMs);
 assert.deepEqual(original,snapshot);
});
test('full reviews and other model assignments remain unchanged',()=>{
 for(const edit of [o=>{o.userPrompt='{}';},o=>{o.userPrompt=JSON.stringify({source_precheck:false});},o=>{o.config.models.primary.model='other';},o=>{o.config.models.primary.provider='minimax-cn';}]){
  const original=fixture();edit(original);assert.equal(configureLocalReview(original),original);
 }
});
