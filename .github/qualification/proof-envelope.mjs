import assert from 'node:assert/strict';
import {supportParameters,normalizeReviewReport} from './support-protocol.mjs';
export const proofEnvelopeSchema={type:'object',properties:{report_json:{type:'string',minLength:2,maxLength:65536,
 description:'One compact JSON review object. supported requires the complete C-code support map; unsupported requires a C-code finding. No markdown fences. The application strictly validates the decoded object.'}},required:['report_json'],additionalProperties:false};
export function parseProofEnvelope(input,originalParameters,data,value){
 assert.ok(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1
  &&typeof input.report_json==='string'&&Buffer.byteLength(input.report_json,'utf8')<=65536,'Expected one bounded report_json string.');
 const report=JSON.parse(input.report_json);const schema=supportParameters(originalParameters,data);
 if(!value.Check(schema,report)){
  const errors=[...value.Errors(schema,report)].slice(0,3).map(e=>e.instancePath+': '+e.message).join('; ');
  throw new Error(('Invalid decoded review: '+errors).slice(0,2048));
 }
 return {report,canonical:normalizeReviewReport(report,data)};
}
