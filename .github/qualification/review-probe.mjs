import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {installProviderArgumentTap} from './provider-argument-tap.mjs';
const root=process.cwd(),load=p=>import(pathToFileURL(path.join(root,p)).href);
const {PiSdkRuntime}=await load('src/core/pi-sdk-runtime.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {compileSpecialistEvidence}=await load('src/core/audit/specialist-compiler.ts');
const {reviewSpecialistCompilation,specialistReviewDigest}=await load('src/core/audit/specialist-review.ts');
const {readReviewPrompt}=await load('tests/fixtures/review-prompt.ts');
const {MODEL_CONFIG,redactSecrets}=await load('scripts/live-installation.mjs');
const preflight=process.argv.includes('--preflight');
assert.ok(process.argv.slice(2).every(a=>a==='--preflight'));
if(preflight)assert.ok(!process.env.PI_API_KEY&&!process.env.MINIMAX_API_KEY,'Preflight receives no model credentials');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const selected=JSON.parse(process.env.REVIEW_CASE),cwd=process.env.PROBE_TARGET,out=process.env.PROBE_EVIDENCE;
assert.equal(git(root,'rev-parse','HEAD'),selected.candidate_sha);
assert.equal(git(root,'rev-parse','HEAD^{tree}'),selected.candidate_tree);
assert.equal(git(cwd,'rev-parse','HEAD'),selected.target_sha);
assert.equal(git(cwd,'status','--porcelain'),'');
function find(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);return e.isDirectory()?find(p):e.isFile()&&e.name==='codebase_map.json'?[p]:[];});}
const files=find(process.env.PROBE_PREVIOUS);assert.equal(files.length,1);
const bytes=fs.readFileSync(files[0]);assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.map_sha256);
const map=JSON.parse(bytes);let body=map.concern_evidence.concerns.find(c=>c.concern===selected.concern);assert.ok(body);
if(selected.positive_control){body={...JSON.parse(fs.readFileSync(new URL('./valid-cache-control.json',import.meta.url),'utf8')),last_updated:body.last_updated};selected.concern=body.concern;}
const originalDigest=specialistReviewDigest(body);
if(selected.false_claim_canary){
 assert.ok(fs.readFileSync(path.join(cwd,'jwt/api_jwt.py'),'utf8').includes('exp = int(payload["exp"])'));
 body.pitfalls.unshift({risk:'Numeric-string exp claim values are always rejected rather than converted to integers.',consequence:'Even a valid numeric string can never be checked as an expiry timestamp.',reference:'jwt/api_jwt.py'});
}
const submittedDigest=specialistReviewDigest(body);
map.concern_evidence.concerns=[body];delete map.specialist_reviews;
const compilation=compileSpecialistEvidence(map,{cwd});assert.ok(compilation.assessment.accepted_concerns.includes(selected.concern));
const budget=new AuditResourceBudget(),sdk=new PiSdkRuntime(),started=Date.now();
const reviewTasks=[],accepted=[],wireSubmissions=[],sdkCalls=[],events=[];
const tap=installProviderArgumentTap();
const runtime={async runSession(options){
 const task=readReviewPrompt(options.userPrompt),observe=options.onEvent;
 const bindings=task.original_claim_context?Object.fromEntries(Object.entries(task.claims).map(([id,c])=>[id,c.original_claim])):null;
 reviewTasks.push({thinking_level:options.config.thinkingLevel,source_precheck:task.source_precheck===true,source_excerpt:task.source_excerpt===true,
  claim_ids:Object.keys(task.claims),source_paths:Object.keys(task.evidence),source_bytes:Object.values(task.evidence).reduce((n,s)=>n+Buffer.byteLength(s),0),
  output_cap:options.maxOutputTokens,timeout_ms:options.timeoutMs,clause_bindings:bindings,
  ...(bindings?{clauses:task.claims,original_claim_context:task.original_claim_context}:{})});
 const tools=options.customTools?.map(tool=>({...tool,async execute(...args){
  const result=await tool.execute(...args);
  if(tool.name==='submit_specialist_review'){
   const report=structuredClone(args[1]);wireSubmissions.push(structuredClone(report));
   // Diagnostics retain both raw wire IDs and their application-owned mapping.
   // This never changes arguments supplied to the production validator.
   if(bindings){report.checked_claims=[...new Set(report.checked_claims.map(id=>bindings[id]))];
    if(report.finding)report.finding.claim=bindings[report.finding.claim];
    for(const finding of report.additional_findings??[])finding.claim=bindings[finding.claim];}
   accepted.push(report);
  }
  return result;
 }}));
 if(preflight)return {turns:0,costUsd:0,aborted:true};
 return sdk.runSession({...options,customTools:tools,onEvent(event){
  if(event.type==='tool_execution_start')sdkCalls.push({id:event.toolCallId,args:event.args});
  observe?.(event);
 }});
}};
if(!preflight)process.env.MINIMAX_API_KEY=process.env.PI_API_KEY;
const output=await reviewSpecialistCompilation({cwd,runtime,config:MODEL_CONFIG,ui:{status(){}},auditLog:{recordMessageEnd(){},sessionEvent({event:e}){
 if(e?.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,toolName:e.toolName,isError:e.isError,...(e.isError?{feedback:JSON.stringify(e.result).slice(0,2200)}:{})});
 if(e?.type==='message_end'&&e.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:e.type,stopReason:e.message.stopReason,errorMessage:e.message.errorMessage});
}}},compilation,budget,'clause-precheck-'+selected.name);
const wire=await tap.finish();
if(preflight){
 assert.ok(reviewTasks.length>0);assert.equal(wire.length,0);assert.equal(budget.snapshot().model_calls,0);assert.equal(accepted.length,0);
 assert.ok(output.map.specialist_reviews?.records.every(r=>r.failure!==null));
 if(selected.known_bad_fragment)assert.ok(reviewTasks.some(t=>t.clause_bindings),'The compound fixture must exercise clause IDs');
 console.log(JSON.stringify({preflight:true,candidate:selected.candidate_sha,case:selected.name,parsed_tasks:reviewTasks.length,model_calls:0,installation_credit:false}));
 process.exit(0);
}
const finalBody=output.map.concern_evidence?.concerns.find(c=>c.concern===selected.concern);
const review=output.map.specialist_reviews?.records.find(r=>r.concern===selected.concern);
const retired=!finalBody&&output.map.concern_evidence?.not_concerns.some(r=>r.candidate===selected.concern);
const found=(claim,file)=>accepted.some(s=>[s.finding,...s.additional_findings??[]].some(f=>f?.claim===claim&&f.path===file));
const result={candidate_sha:selected.candidate_sha,candidate_tree:selected.candidate_tree,case:selected,component_only:true,fresh_installation:false,installation_credit:false,
 production_prompt_unchanged:true,production_budget_overrides:false,compound_clause_precheck:true,canonical_submission_projection:true,
 original_body_digest:originalDigest,submitted_body_digest:submittedDigest,final_body:finalBody,review,review_tasks:reviewTasks,
 accepted_submissions:accepted,wire_submissions:wireSubmissions,provider_wire:wire,
 argument_comparison:wire.flatMap(r=>(r.tool_calls??[]).map(c=>({id:c.id,valid_json:c.valid_json,sdk_match:c.valid_json&&JSON.stringify(c.argument_value)===JSON.stringify(sdkCalls.find(s=>s.id===c.id)?.args)}))),
 positive_control_passed:!selected.positive_control||(review?.failure===null&&specialistReviewDigest(finalBody)===submittedDigest&&accepted.every(s=>s.verdict==='supported')),
 known_bad_body_approved:Boolean(review?.failure===null&&selected.known_bad_fragment&&JSON.stringify(finalBody).includes(selected.known_bad_fragment)),
 cache_contradiction_found:!selected.known_bad_fragment||found('invariants[4]','jwt/jwk_set_cache.py'),
 false_claim_canary:selected.false_claim_canary===true,canary_rejected:!selected.false_claim_canary||found('pitfalls[0]','jwt/api_jwt.py'),
 valid_typed_outcome:review?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')==='',
 elapsed_ms:Date.now()-started,usage:budget.snapshot(),events,release_ready:false};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);assert.ok(result.valid_typed_outcome,'No complete typed review');
assert.ok(result.positive_control_passed,'Correct control changed or was rejected');assert.ok(!result.known_bad_body_approved,'False original claim approved');
assert.ok(result.cache_contradiction_found,'Cache counterexample was not explicitly found');assert.ok(result.canary_rejected,'Numeric coercion canary was not rejected');
if(selected.require_source_precheck)assert.ok(reviewTasks.some(t=>t.source_precheck));
if(selected.require_source_excerpt)assert.ok(reviewTasks.some(t=>t.source_precheck&&t.source_excerpt));
assert.ok(wire.length>0&&wire.every(r=>r.model==='MiniMax-M3'&&r.thinking?.type==='adaptive'&&r.tool_choice?.type==='auto'&&r.max_tokens===12000));
assert.ok(reviewTasks.every(t=>t.thinking_level==='high'&&t.output_cap===12000&&t.timeout_ms>0&&t.timeout_ms<=90000));
