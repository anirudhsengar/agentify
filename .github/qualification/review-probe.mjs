import { evidenceClaimIds, claimBindings, encodedClaims } from './support-protocol.mjs';
import { proofEnvelopeSchema, parseProofEnvelope } from './proof-envelope.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd();const load=p=>import(pathToFileURL(path.join(root,p)).href);
const valueUrl=execFileSync(process.execPath,['--input-type=module','-e',"process.stdout.write(import.meta.resolve('typebox/value'))"],{cwd:root,encoding:'utf8'});
const {Value}=await import(valueUrl);
const {PiSdkRuntime}=await load('src/core/pi-sdk-runtime.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {compileSpecialistEvidence}=await load('src/core/audit/specialist-compiler.ts');
const {reviewSpecialistCompilation,specialistReviewDigest}=await load('src/core/audit/specialist-review.ts');
const {MODEL_CONFIG,redactSecrets}=await load('scripts/live-installation.mjs');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const selected=JSON.parse(process.env.REVIEW_CASE);const out=process.env.PROBE_EVIDENCE,cwd=process.env.PROBE_TARGET;
const candidate=selected.candidate_sha;assert.equal(git(root,'rev-parse','HEAD'),candidate);
assert.equal(git(cwd,'rev-parse','HEAD'),selected.target_sha);assert.equal(git(cwd,'status','--porcelain'),'');
function find(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const f=path.join(directory,e.name);return e.isDirectory()?find(f):e.isFile()&&e.name==='codebase_map.json'?[f]:[];});}
const files=find(process.env.PROBE_PREVIOUS);assert.equal(files.length,1);
const bytes=fs.readFileSync(files[0]);assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.map_sha256);
const map=JSON.parse(bytes);let body=map.concern_evidence.concerns.find(c=>c.concern===selected.concern);assert.ok(body);
if(selected.positive_control){selected.original_concern=selected.concern;body={...JSON.parse(fs.readFileSync(new URL('./valid-cache-control.json',import.meta.url),'utf8')),last_updated:body.last_updated};selected.concern=body.concern;}
const originalDigest=specialistReviewDigest(body);
const canaryRisk='Numeric-string exp claim values are always rejected rather than converted to integers.';
if(selected.false_claim_canary){
 assert.ok(fs.readFileSync(path.join(cwd,'jwt/api_jwt.py'),'utf8').includes('exp = int(payload["exp"])'));
 body.pitfalls.unshift({risk:canaryRisk,consequence:'Even a valid numeric string can never be checked as an expiry timestamp.',reference:'jwt/api_jwt.py'});
}
const submittedBodyDigest=specialistReviewDigest(body);const acceptedSubmissions=[];
// Re-review the unchanged, captured body; this controlled input is not a fresh installation.
map.concern_evidence.concerns=[body];delete map.specialist_reviews;
const compilation=compileSpecialistEvidence(map,{cwd});assert.ok(compilation.assessment.accepted_concerns.includes(selected.concern));
const initialNormalizedDigest=specialistReviewDigest(compilation.map.concern_evidence.concerns.find(c=>c.concern===selected.concern));
const budget=new AuditResourceBudget();const started=Date.now();const events=[];const stream={first_update_ms:null,last_update_ms:null,updates:0,types:{}};
function readableEvidence(serialized) {
 const data=JSON.parse(serialized);
 const bindings=claimBindings(data);
 const originalToCode=Object.fromEntries(Object.entries(bindings).map(([code,id])=>[id,code]));
 const sections=['UNTRUSTED ASSIGNED CLAIMS (use C-codes in the submission):',JSON.stringify(encodedClaims(data),null,2),'CODES REQUIRING SOURCE JUSTIFICATION:',JSON.stringify(evidenceClaimIds(data).map(id=>originalToCode[id])),
  'FULL BEHAVIOR CONTEXT (not approval credit for unassigned claims):',JSON.stringify(data.scope_context??{}),
  'APPLICATION ATTACHMENT DATA:',JSON.stringify(data.compiler_attachments)];
 const mentions=(value,file)=>typeof value==='string'?value.includes(file):Array.isArray(value)?value.some(x=>mentions(x,file)):
  value&&typeof value==='object'?Object.values(value).some(x=>mentions(x,file)):false;
 for(const [sourceId,[file,source]] of Object.entries(data.evidence).entries()){
  const marker='source_'+createHash('sha256').update(file+'\0'+source).digest('hex');assert.ok(!source.includes(marker));
  sections.push('IMMUTABLE UNTRUSTED SOURCE S'+sourceId+' '+JSON.stringify(file)+'; assigned references '+JSON.stringify(Object.entries(data.claims).filter(([,value])=>mentions(value,file)).map(([id])=>originalToCode[id])),
   '<'+marker+'>',source.split('\n').map((line,index)=>String(index+1).padStart(5,'0')+'|'+line).join('\n'),'</'+marker+'>');
 }
 sections.push(data.assignment??'Review all supplied claim IDs.', 'End of untrusted evidence. Apply the system contract and return the typed source decision.');
 return sections.join('\n\n');
}
function keyedPrompt(prompt){
 return 'The submission tool accepts one report_json string. Put the complete review object in that string as compact JSON, without markdown fences. The decoded object is strictly validated and contains verdict and either the complete support map or one finding. Do not put those inner fields directly in the tool arguments. Citation fields are source (integer S-index), start_line (integer), end_line (integer), and reason (string). Supported shape: {"verdict":"supported","support":{"C000":{"source":0,"start_line":1,"end_line":1,"reason":"Explain the whole claim."},"C001":true}}. Unsupported shape: {"verdict":"unsupported","finding":{"claim":"C000","source":0,"start_line":1,"end_line":1,"reason":"Explain the exact contradiction."}}. These illustrate syntax only: use the actual assigned codes and source evidence, and include every code for support. '
  + prompt.replaceAll('checked_claims','support').replace('listing every checked ID','justifying every assigned ID in the support object')
  + ' The final tool schema is authoritative: for supported return support as an object keyed by EVERY assigned C-code, for example C000. The mapping to original claim IDs is application-owned. Never emit canonical names such as invariants[0] as object keys or findings; use the supplied C-code. Each nonempty claim needs source, start_line, end_line and a brief reason establishing ALL clauses; explicitly acknowledge an empty collection with true. For unsupported OMIT support and give the decisive finding using claim, source, start_line, end_line and reason. Do not return checked_claims, support_evidence, path or excerpt. Positive references may cover the complete relevant source scope; negative findings must select a short span within 1024 characters. Check each predicate separately from its callers: their return values can differ on the same input state. Derive the outcome of every conjunct, disjunct, early return and boundary comparison from the supplied immutable source, without assuming what a related function returns.';
}
const sdk=new PiSdkRuntime();
const runtime={async runSession(options){const observe=options.onEvent;return sdk.runSession({...options,userPrompt:readableEvidence(options.userPrompt),systemPrompt:keyedPrompt(options.systemPrompt),customTools:options.customTools?.map(tool=>({...tool,
 description:'Submit unsupported with an exact-source finding, or supported with a complete claim-keyed support map. Missing, conflicting or incomplete proof is not approval.',
 parameters:proofEnvelopeSchema,async execute(...args){
 const {report,canonical}=parseProofEnvelope(args[1],tool.parameters,JSON.parse(options.userPrompt),Value);const result=await tool.execute(args[0],canonical,...args.slice(2));
 if(tool.name==='submit_specialist_review')acceptedSubmissions.push({...structuredClone(canonical),citation_report:structuredClone(report),assigned_claim_ids:Object.keys(JSON.parse(options.userPrompt).claims),finding_claim_value:JSON.parse(options.userPrompt).claims[canonical.finding?.claim]??null});return result;}})),onEvent(event){if(event.type==='message_update'){stream.updates++;stream.first_update_ms??=Date.now()-started;stream.last_update_ms=Date.now()-started;const type=event.assistantMessageEvent?.type??'unknown';stream.types[type]=(stream.types[type]??0)+1;}observe?.(event);}});}};
process.env.MINIMAX_API_KEY=process.env.PI_API_KEY;
const output=await reviewSpecialistCompilation({cwd,runtime,config:{...MODEL_CONFIG,thinkingLevel:selected.thinking_level??MODEL_CONFIG.thinkingLevel},
 ui:{status(){}},auditLog:{recordMessageEnd(){},sessionEvent(value){
  const e=value.event;
  if(e?.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,toolName:e.toolName,isError:e.isError,feedback:e.isError?JSON.stringify(e.result).slice(0,2200):undefined});
  if(e?.type==='message_end'&&e.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:'message_end',stopReason:e.message.stopReason,errorMessage:e.message.errorMessage});
 }}},compilation,budget,'explicit-verdict-live-'+selected.name);
const record=output.map.specialist_reviews?.records.find(r=>r.concern===selected.concern);
const retired=output.map.concern_evidence?.not_concerns.some(r=>r.candidate===selected.concern)&&!output.map.concern_evidence?.concerns.some(r=>r.concern===selected.concern);
const finalBody=output.map.concern_evidence?.concerns.find(c=>c.concern===selected.concern);
const result={candidate_sha:candidate,positive_control_passed:!selected.positive_control||(record?.failure===null&&specialistReviewDigest(finalBody)===initialNormalizedDigest&&acceptedSubmissions.every(s=>s.verdict==='supported')),known_bad_body_approved:record?.failure===null&&selected.known_bad_fragment&&JSON.stringify(finalBody).includes(selected.known_bad_fragment),final_body:finalBody,source_line_citation_experiment:true,claim_keyed_proofs:true,opaque_claim_codes:true,json_envelope_transport:true,thinking_configuration_experiment:selected.thinking_level??"high",serial_comparison:true,approval_evidence_experiment:true,all_source_bytes_preserved:true,readable_source_with_claim_index:true,production_review_gates_unchanged:true,case:selected,component_only:true,production_prompt_unchanged:false,native_terminal_selection:true,fresh_installation:false,installation_credit:false,original_body_digest:originalDigest,submitted_body_digest:submittedBodyDigest,false_claim_canary:selected.false_claim_canary===true,accepted_submissions:acceptedSubmissions,canary_rejected:!selected.false_claim_canary||acceptedSubmissions.some(v=>v.verdict==='unsupported'&&v.finding?.claim==='pitfalls[0]'&&v.finding?.path==='jwt/api_jwt.py'),elapsed_ms:Date.now()-started,production_budget_overrides:false,usage:budget.snapshot(),stream,events,review:record??null,serialized_live_probe:true,retired_after_source_review:retired===true,valid_typed_outcome:record?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')===''};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);assert.ok(result.positive_control_passed,'valid source control was rejected, changed or incompletely reviewed');assert.ok(!result.known_bad_body_approved,'known source contradiction was approved');if(selected.false_claim_canary)assert.ok(result.canary_rejected,'false numeric-expiry canary was not explicitly rejected');else assert.ok(result.valid_typed_outcome,'bounded review did not reach an explicit typed outcome');
