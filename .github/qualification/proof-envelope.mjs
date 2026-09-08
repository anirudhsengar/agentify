import assert from 'node:assert/strict';
import {supportParameters,normalizeReviewReport} from './support-protocol.mjs';
export const proofEnvelopeSchema={type:'object',properties:{review_text:{type:'string',minLength:2,maxLength:65536,
 description:'Line protocol: first line SUPPORTED or UNSUPPORTED. Then C000 S0:1-2 explanation, one line per claim. An explicitly empty assigned collection uses C001 EMPTY. No JSON, Markdown tables or fences inside the string. Every decoded record is strictly source-validated.'}},required:['review_text'],additionalProperties:false};
export function parseProofEnvelope(input,originalParameters,data,value){
 assert.ok(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1
  &&typeof input.review_text==='string'&&Buffer.byteLength(input.review_text,'utf8')<=65536,'Expected one bounded review_text string.');
 const lines=input.review_text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const header=lines.shift();assert.ok(header==='SUPPORTED'||header==='UNSUPPORTED','First line must be SUPPORTED or UNSUPPORTED.');
 const support={};const findings=[];const seen=new Set();
 for(const line of lines){
  const empty=/^(C[0-9]{3})[ \t]+EMPTY$/.exec(line);
  const match=/^(C[0-9]{3})[ \t]+S([0-9]+):([0-9]+)-([0-9]+)[ \t]+(.+)$/.exec(line);
  assert.ok(empty||match,'Expected C-code, S-index:inclusive-lines and justification on each line; invalid record: '+line.slice(0,160));
  const claim=(empty??match)[1];assert.ok(!seen.has(claim),'Duplicate claim record.');seen.add(claim);
  if(empty){assert.equal(header,'SUPPORTED','An unsupported assertion needs source evidence.');support[claim]=true;continue;}
  const record={source:Number(match[2]),start_line:Number(match[3]),end_line:Number(match[4]),reason:match[5]};
  if(header==='SUPPORTED')support[claim]=record;else findings.push({claim,...record});
 }
 const report=header==='SUPPORTED'?{verdict:'supported',support}:{verdict:'unsupported',finding:findings[0],...(findings.length>1?{additional_findings:findings.slice(1)}:{})};
 const schema=supportParameters(originalParameters,data);
 if(!value.Check(schema,report)){
  const errors=[...value.Errors(schema,report)].slice(0,3).map(e=>e.instancePath+': '+e.message).join('; ');
  throw new Error(('Invalid decoded review: '+errors+'. Return the complete corrected review_text, not a delta; preserve every assigned C-code.').slice(0,2048));
 }
 return {report,canonical:normalizeReviewReport(report,data)};
}
