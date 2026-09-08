import assert from 'node:assert/strict';
import test from 'node:test';
import {cancellationObservations} from './cancellation-events.mjs';
const log=(...events)=>events.map(event=>JSON.stringify({payload:JSON.stringify({event})})+'\n').join('');
const response={type:'message_end',role:'assistant',stopReason:'toolUse',usage:{output:12}};
const start={type:'tool_execution_start',toolName:'write_map_delta',toolCallId:'real-checkpoint'};
const scout={type:'tool_execution_start',toolName:'spawn_explorer',toolCallId:'agentify-initial-scout:real-checkpoint'};
test('an application initial scout proves its pending map write already passed validation',()=>{
 const result=cancellationObservations(log(response,start,scout));
 assert.equal(result.response,true);assert.equal(result.checkpoint,true);
 assert.equal(result.checkpointProof,'application-initial-scout-after-map-write');
});
test('unmatched, failed, and incomplete calls cannot claim a checkpoint',()=>{
 for(const text of [log(response,scout),log(response,start,{...scout,toolCallId:'ordinary-model-call'}),
  log(response,start,{...scout,toolCallId:'agentify-initial-scout:other-call'}),
  log(response,start,{type:'tool_execution_end',toolName:'write_map_delta',toolCallId:'real-checkpoint',isError:true},scout),
  log(response,start)+JSON.stringify({payload:JSON.stringify({event:scout})})]){
  assert.equal(cancellationObservations(text).checkpoint,false);
 }
});
test('successful checkpoint acknowledgment still works but not a provider error alone',()=>{
 const result=cancellationObservations(log({...response,stopReason:'error'},start,
  {type:'tool_execution_end',toolName:'write_map_delta',toolCallId:'real-checkpoint',isError:false}));
 assert.equal(result.response,false);assert.equal(result.checkpoint,true);
 assert.equal(result.checkpointProof,'successful-map-tool-result');
});
