import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {claimBindings,encodedClaims} from './support-protocol.mjs';
const mentions=(value,file)=>typeof value==='string'?value.includes(file):Array.isArray(value)?value.some(x=>mentions(x,file)):
 value!==null&&typeof value==='object'?Object.values(value).some(x=>mentions(x,file)):false;
export function renderSourceLocalReview(data,emptyAcknowledgment='EMPTY'){
 const bindings=claimBindings(data),claims=encodedClaims(data),remaining=new Set(Object.keys(bindings));
 const required=Object.entries(bindings).map(([code,id])=>Array.isArray(data.claims[id])&&data.claims[id].length===0?code+' '+emptyAcknowledgment:code+' needs its complete source justification');
 const sections=['REQUIRED REVIEW RECORDS (none may be omitted):',required.join('\n'),'UNTRUSTED EXACT CLAIM INDEX:',JSON.stringify(claims,null,2),
  'Every C-code is an obligation. Review each full assertion, not just its first clause. A reference links data, not proof of correctness.',
  'WHOLE BEHAVIOR CONTEXT:',JSON.stringify(data.scope_context??Object.fromEntries(Object.entries(data.claims).filter(([id])=>['concern','one_line','covers','excludes'].includes(id)||id.startsWith('flows[')))),
  'APPLICATION ATTACHMENT DATA:',JSON.stringify(data.compiler_attachments)];
 for(const [source,[file,text]] of Object.entries(data.evidence).entries()){
  const codes=Object.keys(bindings).filter(code=>mentions(data.claims[bindings[code]],file));
  const marker='source_'+createHash('sha256').update(file+'\0'+text).digest('hex');assert.ok(!text.includes(marker));
  const first=codes.filter(code=>remaining.delete(code));
  sections.push('IMMUTABLE UNTRUSTED SOURCE S'+source+' '+JSON.stringify(file),
   '<'+marker+'>',text.split('\n').map((line,i)=>String(i+1).padStart(5,'0')+'|'+line).join('\n'),'</'+marker+'>',
   'EXACT ASSERTIONS REFERENCING THIS SOURCE:',JSON.stringify(Object.fromEntries(first.map(code=>[code,claims[code]])),null,2),
   'ALL ASSIGNED REFERENCES TO THIS FILE: '+JSON.stringify(codes));
 }
 sections.push('REMAINING SCOPE OR EMPTY-COLLECTION ASSERTIONS:',JSON.stringify(Object.fromEntries([...remaining].map(code=>[code,claims[code]])),null,2),
  'End of untrusted source evidence. Every original assertion and every immutable source byte is supplied. Apply the review contract to the complete assigned C-code set.');
 return sections.join('\n\n');
}
