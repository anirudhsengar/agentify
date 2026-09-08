import {installProviderArgumentTap} from './provider-argument-tap.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd();const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {PiSdkRuntime}=await load('src/core/pi-sdk-runtime.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {compileSpecialistEvidence}=await load('src/core/audit/specialist-compiler.ts');
const {reviewSpecialistCompilation,specialistReviewDigest}=await load('src/core/audit/specialist-review.ts');
const {MODEL_CONFIG,redactSecrets}=await load('scripts/live-installation.mjs');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const selected=JSON.parse(process.env.REVIEW_CASE);const out=process.env.PROBE_EVIDENCE,cwd=process.env.PROBE_TARGET;
const candidate=selected.candidate_sha;assert.equal(git(root,'rev-parse','HEAD'),candidate);assert.equal(git(root,'rev-parse','HEAD^{tree}'),selected.candidate_tree);
assert.equal(git(cwd,'rev-parse','HEAD'),selected.target_sha);assert.equal(git(cwd,'status','--porcelain'),'');
function find(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const f=path.join(directory,e.name);return e.isDirectory()?find(f):e.isFile()&&e.name==='codebase_map.json'?[f]:[];});}
const files=find(process.env.PROBE_PREVIOUS);assert.equal(files.length,1);
const bytes=fs.readFileSync(files[0]);assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.map_sha256);
const map=JSON.parse(bytes);let body=map.concern_evidence.concerns.find(c=>c.concern===selected.concern);assert.ok(body);
if(selected.positive_control){body={...JSON.parse(fs.readFileSync(new URL('./valid-cache-control.json',import.meta.url),'utf8')),last_updated:body.last_updated};selected.concern=body.concern;}
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
const budget=new AuditResourceBudget();const started=Date.now();const events=[];const stream={first_update_ms:null,last_update_ms:null,updates:0,types:{}};
const wireTap=installProviderArgumentTap();const reviewTasks=[];
const sdk=new PiSdkRuntime();const sdkCalls=[];
const runtime={async runSession(options){const observe=options.onEvent;const task=JSON.parse(options.userPrompt);reviewTasks.push({source_precheck:task.source_precheck===true,source_excerpt:task.source_excerpt===true,claim_ids:Object.keys(task.claims),source_paths:Object.keys(task.evidence),source_bytes:Object.values(task.evidence).reduce((n,s)=>n+Buffer.byteLength(s),0),output_cap:options.maxOutputTokens,timeout_ms:options.timeoutMs});return sdk.runSession({...options,customTools:options.customTools?.map(tool=>({...tool,async execute(...args){const result=await tool.execute(...args);if(tool.name==='submit_specialist_review')acceptedSubmissions.push(structuredClone(args[1]));return result;}})),onEvent(event){if(event.type==='tool_execution_start')sdkCalls.push({id:event.toolCallId,args:event.args});if(event.type==='message_update'){stream.updates++;stream.first_update_ms??=Date.now()-started;stream.last_update_ms=Date.now()-started;const type=event.assistantMessageEvent?.type??'unknown';stream.types[type]=(stream.types[type]??0)+1;}observe?.(event);}});}};
process.env.MINIMAX_API_KEY=process.env.PI_API_KEY;
const output=await reviewSpecialistCompilation({cwd,runtime,config:MODEL_CONFIG,
 ui:{status(){}},auditLog:{recordMessageEnd(){},sessionEvent(value){
  const e=value.event;
  if(e?.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,toolName:e.toolName,isError:e.isError,feedback:e.isError?JSON.stringify(e.result).slice(0,2200):undefined});
  if(e?.type==='message_end'&&e.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:'message_end',stopReason:e.message.stopReason,errorMessage:e.message.errorMessage});
 }}},compilation,budget,'explicit-verdict-live-'+selected.name);
const provider_wire=await wireTap.finish();
const argument_comparison=provider_wire.flatMap(request=>(request.tool_calls??[]).map(call=>({id:call.id,valid_json:call.valid_json,sdk_match:call.valid_json&&JSON.stringify(call.argument_value)===JSON.stringify(sdkCalls.find(item=>item.id===call.id)?.args)})));
const finalBody=output.map.concern_evidence?.concerns.find(c=>c.concern===selected.concern);
const record=output.map.specialist_reviews?.records.find(r=>r.concern===selected.concern);
const retired=output.map.concern_evidence?.not_concerns.some(r=>r.candidate===selected.concern)&&!output.map.concern_evidence?.concerns.some(r=>r.concern===selected.concern);
const result={candidate_sha:candidate,candidate_tree:selected.candidate_tree,final_body:finalBody,source_local_precheck_experiment:true,review_tasks:reviewTasks,provider_wire,argument_comparison,positive_control_passed:!selected.positive_control||(record?.failure===null&&specialistReviewDigest(finalBody)===submittedBodyDigest&&acceptedSubmissions.every(s=>s.verdict==='supported')),known_bad_body_approved:Boolean(record?.failure===null&&selected.known_bad_fragment&&JSON.stringify(finalBody).includes(selected.known_bad_fragment)),documented_thinking_wire:true,case:selected,component_only:true,production_prompt_unchanged:true,native_terminal_selection:true,fresh_installation:false,installation_credit:false,original_body_digest:originalDigest,submitted_body_digest:submittedBodyDigest,false_claim_canary:selected.false_claim_canary===true,accepted_submissions:acceptedSubmissions,canary_rejected:!selected.false_claim_canary||acceptedSubmissions.some(v=>v.verdict==='unsupported'&&v.finding?.claim==='pitfalls[0]'&&v.finding?.path==='jwt/api_jwt.py'),elapsed_ms:Date.now()-started,production_budget_overrides:false,usage:budget.snapshot(),stream,events,review:record??null,serialized_live_probe:true,retired_after_source_review:retired===true,valid_typed_outcome:record?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')===''};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);assert.ok(result.valid_typed_outcome,"Every source control requires a complete typed outcome, not merely an attempted finding");if(selected.require_source_excerpt)assert.ok(reviewTasks.some(t=>t.source_precheck&&t.source_excerpt),'Required bounded source excerpt did not execute');if(selected.require_source_precheck)assert.ok(reviewTasks.some(t=>t.source_precheck),'Required source-local precheck did not execute');assert.ok(provider_wire.length>0&&provider_wire.every(r=>r.model==='MiniMax-M3'&&r.thinking?.type==='adaptive'&&r.tool_choice?.type==='auto'&&r.max_tokens===12000),'Actual wire did not preserve documented thinking mode and output cap');assert.ok(result.positive_control_passed,'Valid cache control was rejected or changed');assert.ok(!result.known_bad_body_approved,'Known source contradiction was approved');if(selected.false_claim_canary)assert.ok(result.canary_rejected,'false numeric-expiry canary was not explicitly rejected');else assert.ok(result.valid_typed_outcome,'bounded review did not reach an explicit typed outcome');
