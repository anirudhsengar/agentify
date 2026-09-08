import {createClaimRecordTool} from './claim-record-tool.mjs';
import {renderSourceLocalReview} from './source-local-review.mjs';
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
const submittedBodyDigest=specialistReviewDigest(body);const acceptedSubmissions=[];const attemptedSubmissions=[];
// Re-review the unchanged, captured body; this controlled input is not a fresh installation.
map.concern_evidence.concerns=[body];delete map.specialist_reviews;
const compilation=compileSpecialistEvidence(map,{cwd});assert.ok(compilation.assessment.accepted_concerns.includes(selected.concern));
const initialNormalizedDigest=specialistReviewDigest(compilation.map.concern_evidence.concerns.find(c=>c.concern===selected.concern));
const budget=new AuditResourceBudget();const started=Date.now();const events=[];const stream={first_update_ms:null,last_update_ms:null,updates:0,types:{}};
function readableEvidence(serialized) {return renderSourceLocalReview(JSON.parse(serialized),'empty collection: explicitly acknowledge source=-1, start_line=0, end_line=0');}
function keyedPrompt(prompt){
 const boundary=prompt.indexOf('Submit a compact typed review.');assert.ok(boundary>=0);
 return prompt.slice(0,boundary)+' Submit one flat tool call per assigned C-code through submit_specialist_review. For a complete supported review, emit ALL calls in the SAME provider response, not one conversational turn per claim. Each call has claim (C-code), verdict, source (S-index integer), start_line, end_line, reason. For an explicitly empty collection acknowledge source=-1 and both line values 0; other proofs cite real source. Each supported proof must establish every clause. A source contradiction needs just one unsupported call and a short source span. Stop at that decisive finding. Individual supported records do not approve the body: the application waits for all assigned claims. If a batch is rejected for missing records, prior valid proofs remain pending; use the one permitted correction response for only the missing or invalid records. Do not repeat unrelated work, produce JSON envelopes, or use arrays in scalar fields. Source predicates and caller return values are separate facts; test empty, boundary, missing, disabled and exception states. Only the original complete-claim and exact-source gates can approve the body.';
}
const sdk=new PiSdkRuntime();const claimBatches=[];
const runtime={async runSession(options){
 const data=JSON.parse(options.userPrompt);const adapters=options.customTools.map(original=>{
  const terminal={...original,async execute(id,canonical,...rest){const result=await original.execute(id,canonical,...rest);
   acceptedSubmissions.push({...structuredClone(canonical),assigned_claim_ids:Object.keys(data.claims),finding_claim_value:data.claims[canonical.finding?.claim]??null});return result;}};
  return createClaimRecordTool(terminal,data,Value);
 });
 try{return await sdk.runSession({...options,userPrompt:readableEvidence(options.userPrompt),systemPrompt:keyedPrompt(options.systemPrompt),
  forceRequiredToolChoice:false,customTools:adapters.map(adapter=>adapter.tool),onEvent(event){
   adapters.forEach(adapter=>adapter.observe(event));
   if(event.type==='tool_execution_start'&&event.toolName==='submit_specialist_review'){const raw=JSON.stringify(event.args??null);attemptedSubmissions.push({elapsed_ms:Date.now()-started,args:raw.length<=65536?event.args:{truncated:raw.slice(0,65536)}});}
   if(event.type==='message_update'){stream.updates++;stream.first_update_ms??=Date.now()-started;stream.last_update_ms=Date.now()-started;const type=event.assistantMessageEvent?.type??'unknown';stream.types[type]=(stream.types[type]??0)+1;}
   options.onEvent?.(event);
  }});}finally{claimBatches.push(...adapters.map(adapter=>adapter.snapshot()));}
}};
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
const result={candidate_sha:candidate,positive_control_passed:!selected.positive_control||(record?.failure===null&&specialistReviewDigest(finalBody)===initialNormalizedDigest&&acceptedSubmissions.every(s=>s.verdict==='supported')),known_bad_body_approved:record?.failure===null&&selected.known_bad_fragment&&JSON.stringify(finalBody).includes(selected.known_bad_fragment),final_body:finalBody,source_line_citation_experiment:true,claim_keyed_proofs:true,opaque_claim_codes:true,flat_claim_record_transport:true,automatic_tool_selection_experiment:true,claim_batches:claimBatches,monolithic_review_with_argument_repair:true,source_local_claim_rendering:true,thinking_configuration_experiment:selected.thinking_level??"high",serial_comparison:true,approval_evidence_experiment:true,all_source_bytes_preserved:true,readable_source_with_claim_index:true,production_review_gates_unchanged:true,case:selected,component_only:true,production_prompt_unchanged:false,native_terminal_selection:true,fresh_installation:false,installation_credit:false,original_body_digest:originalDigest,submitted_body_digest:submittedBodyDigest,false_claim_canary:selected.false_claim_canary===true,accepted_submissions:acceptedSubmissions,attempted_submissions:attemptedSubmissions,canary_rejected:!selected.false_claim_canary||acceptedSubmissions.some(v=>v.verdict==='unsupported'&&v.finding?.claim==='pitfalls[0]'&&v.finding?.path==='jwt/api_jwt.py'),elapsed_ms:Date.now()-started,production_budget_overrides:false,usage:budget.snapshot(),stream,events,review:record??null,serialized_live_probe:true,retired_after_source_review:retired===true,valid_typed_outcome:record?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')===''};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);assert.ok(result.positive_control_passed,'valid source control was rejected, changed or incompletely reviewed');assert.ok(!result.known_bad_body_approved,'known source contradiction was approved');if(selected.false_claim_canary)assert.ok(result.canary_rejected,'false numeric-expiry canary was not explicitly rejected');else assert.ok(result.valid_typed_outcome,'bounded review did not reach an explicit typed outcome');
