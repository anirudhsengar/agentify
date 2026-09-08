import assert from 'node:assert/strict';
import {claimBindings,materializeCitation} from './support-protocol.mjs';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function createClaimRecordTool(original,data,value){
 const bindings=claimBindings(data),proofs=new Map();let pending=new Set();let completed=false;let rejectedBatch=false;
 const parameters={type:'object',properties:{
  claim:{type:'string',enum:Object.keys(bindings),description:'One exact assigned C-code.'},
  verdict:{type:'string',enum:['supported','unsupported']},
  source:{type:'integer',minimum:-1,maximum:Object.keys(data.evidence).length-1,description:'Immutable S-index; -1 only for an explicitly empty assigned collection.'},
  start_line:{type:'integer',minimum:0},end_line:{type:'integer',minimum:0},
  reason:{type:'string',minLength:1,maxLength:1024,description:'Justify the entire assertion, or explain one decisive counterexample from source.'}},
  required:['claim','verdict','source','start_line','end_line','reason'],additionalProperties:false};
 function observe(event){
  if(event?.type==='message_end'&&event.message?.role==='assistant'){
   pending=new Set((event.message.content??[]).filter(c=>c.type==='toolCall'&&c.name===original.name).map(c=>c.id));
   rejectedBatch=false;
  }
  if(event?.type==='tool_execution_end'&&event.toolName===original.name&&event.isError)rejectedBatch=true;
 }
 const tool={...original,parameters,
  description:'Review one assigned claim per call. Batch all supported C-codes in one response; stop at the first source contradiction. Individual support is not whole-body approval.',
  prepareArguments(input){
   if(!object(input))return input;const next={...input};
   for(const key of ['source','start_line','end_line'])if(typeof next[key]==='string'&&/^-?(0|[1-9][0-9]*)$/.test(next[key])&&Number.isSafeInteger(Number(next[key])))next[key]=Number(next[key]);
   return next;
  },
  async execute(id,report,...rest){
   try{
    assert.ok(!completed,'A terminal review has already been recorded.');
    assert.ok(pending.has(id),'Claim result has no matching provider tool call.');pending.delete(id);
    assert.ok(value.Check(parameters,report),'Malformed claim review record.');
    const canonicalId=bindings[report.claim];const assertion=data.claims[canonicalId];
    const empty=Array.isArray(assertion)&&assertion.length===0;
    if(report.verdict==='unsupported'){
     assert.ok(!empty,'An empty claim has no behavioral assertion to contradict.');
     const finding=materializeCitation({...report,claim:canonicalId},data);
     const result=await original.execute(id,{verdict:'unsupported',checked_claims:[],finding},...rest);
     completed=true;return result;
    }
    if(empty)assert.ok(report.source===-1&&report.start_line===0&&report.end_line===0,'Empty collections require explicit -1,0,0 acknowledgment.');
    else materializeCitation({...report,claim:canonicalId},data,512*1024);
    if(proofs.has(report.claim))assert.deepEqual(proofs.get(report.claim),report,'Repeated claim proof must match the accepted proof exactly.');
    else proofs.set(report.claim,structuredClone(report));
    if(pending.size===0){
     const missing=Object.keys(bindings).filter(code=>!proofs.has(code));
     assert.ok(!rejectedBatch&&missing.length===0,'Incomplete review: '+(missing.length?'missing '+missing.join(', '):'a call in this batch failed')+'. Prior valid records remain pending, not approved; correct only the missing or invalid records.');
     const result=await original.execute(id,{verdict:'supported',checked_claims:Object.values(bindings)},...rest);
     completed=true;return result;
    }
    return {content:[{type:'text',text:'Source proof retained for '+report.claim+'; whole-body approval remains pending.'}],details:{partial_review:true}};
   }catch(error){rejectedBatch=true;throw error;}
  }};
 return {tool,observe,snapshot:()=>({completed,accepted_codes:[...proofs.keys()],pending_calls:[...pending]})};
}
