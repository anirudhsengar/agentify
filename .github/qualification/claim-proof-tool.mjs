import assert from 'node:assert/strict';

/** Validation-only wire adapter: a partial proof never becomes a full review. */
export function createClaimProofTool(original,data,value){
 const ids=Object.keys(data.claims),proofs=new Map();let pending=new Set(),batchFailed=false,completed=false;
 const parameters={type:'object',properties:{
  claim:{type:'string',enum:ids,description:'One exact ORIGINAL assigned claim ID.'},
  verdict:{type:'string',enum:['supported','unsupported']},
  path:{type:'string',enum:[...Object.keys(data.evidence),''],description:'Exact immutable source path. Empty only to acknowledge an empty collection.'},
  excerpt:{type:'string',maxLength:1024,description:'One short contiguous verbatim source expression. Empty only for an empty collection.'},
  reason:{type:'string',minLength:1,maxLength:1024,description:'Explain why every clause follows from source, or identify a precise counterexample. A nearby matching keyword is not support.'}
 },required:['claim','verdict','path','excerpt','reason'],additionalProperties:false};
 function observe(event){
  if(event?.type==='message_end'&&event.message?.role==='assistant'){
   const calls=(event.message.content??[]).filter(item=>item.type==='toolCall');
   pending=new Set(calls.filter(item=>item.name===original.name).map(item=>item.id));
   batchFailed=calls.some(item=>item.name!==original.name);
  }
  if(event?.type==='tool_execution_end'&&event.toolName===original.name&&event.isError){batchFailed=true;pending.delete(event.toolCallId);}
 }
 const tool={...original,parameters,
  description:'Record a sourced decision for one original claim. Submit every supported claim in one response using separate tool calls, or stop immediately at a decisive source contradiction. Partial batches cannot approve a specialist.',
  async execute(id,report,...rest){
   try{
    rest[0]?.throwIfAborted();
    assert.ok(!completed&&pending.has(id),'No pending provider call for this claim proof.');pending.delete(id);
    assert.ok(value.Check(parameters,report),'Invalid source-backed claim decision.');
    const assertion=data.claims[report.claim],empty=Array.isArray(assertion)&&assertion.length===0;
    assert.ok(report.reason.trim(),'A sourced justification is required.');
    if(empty)assert.ok(report.verdict==='supported'&&report.path===''&&report.excerpt==='',
     'An empty collection needs explicit supported acknowledgment with empty path and excerpt.');
    else assert.ok(Object.hasOwn(data.evidence,report.path)&&report.excerpt.trim()
     &&data.evidence[report.path].includes(report.excerpt),'The proof must quote exact supplied immutable source.');
    if(report.verdict==='unsupported'){
     const {claim,path,excerpt,reason}=report;
     const result=await original.execute(id,{verdict:'unsupported',checked_claims:[],finding:{claim,path,excerpt,reason}},...rest);
     completed=true;return result;
    }
    if(!proofs.has(report.claim))proofs.set(report.claim,structuredClone(report));
    if(pending.size>0)return {content:[{type:'text',text:'Claim proof retained; complete review is still pending.'}],details:{partial_review:true}};
    const missing=ids.filter(claim=>!proofs.has(claim));
    assert.ok(!batchFailed&&missing.length===0,'Incomplete review: '+(missing.length?'missing '+missing.join(', '):'a provider call was invalid')+'. Correct only missing or invalid proof records. No approval has been granted.');
    const result=await original.execute(id,{verdict:'supported',checked_claims:ids},...rest);
    completed=true;return result;
   }catch(error){batchFailed=true;throw error;}
  }
 };
 return {tool,observe,snapshot:()=>({completed,accepted_proofs:[...proofs.values()],pending_calls:[...pending]})};
}
