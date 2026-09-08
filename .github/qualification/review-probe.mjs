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
const candidate=selected.candidate_sha;assert.equal(git(root,'rev-parse','HEAD'),candidate);
assert.equal(git(cwd,'rev-parse','HEAD'),selected.target_sha);assert.equal(git(cwd,'status','--porcelain'),'');
function find(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const f=path.join(directory,e.name);return e.isDirectory()?find(f):e.isFile()&&e.name==='codebase_map.json'?[f]:[];});}
const files=find(process.env.PROBE_PREVIOUS);assert.equal(files.length,1);
const bytes=fs.readFileSync(files[0]);assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.map_sha256);
const map=JSON.parse(bytes);const body=map.concern_evidence.concerns.find(c=>c.concern===selected.concern);assert.ok(body);
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
function supportParameters(parameters) {
 return {...parameters,properties:{...parameters.properties,support_evidence:{type:'array',maxItems:512,
  description:'For supported, provide one source-backed justification for every assigned claim ID, including every clause and condition. For unsupported, omit this field and supply the decisive source finding.',
  items:{type:'object',properties:{claim:structuredClone(parameters.properties.checked_claims.items),path:{type:'string'},
   excerpt:{type:'string',minLength:1,maxLength:1024},reason:{type:'string',minLength:1,maxLength:512,
    description:'Explain why the exact source supports the whole claim, not just one clause. Check its conditional and quantified statements against a counterexample state.'}},
   required:['claim','path','excerpt','reason'],additionalProperties:false}}}};
}
function validateSupport(report,data) {
 if(report.verdict!=='supported')return;
 assert.ok(Array.isArray(report.support_evidence),'Supported verdict requires source evidence for every assigned claim.');
 const ids=Object.keys(data.claims);assert.equal(report.support_evidence.length,ids.length,'Every assigned ID needs its own supporting evidence.');
 const seen=new Set();
 for(const proof of report.support_evidence){
  assert.ok(ids.includes(proof.claim)&&!seen.has(proof.claim),'Support IDs must be known, complete and unique.');seen.add(proof.claim);
  assert.ok(typeof proof.reason==='string'&&proof.reason.trim()&&proof.reason.length<=512,'Whole-claim support reason required.');
  const source=data.evidence[proof.path];assert.ok(typeof source==='string','Support path must be supplied immutable source.');
  assert.ok(typeof proof.excerpt==='string'&&proof.excerpt.trim()&&proof.excerpt.length<=1024,'Support quote must be bounded and nonempty.');
  const margins=[...new Set(source.split('\n').map(line=>/^[ \t]+/.exec(line)?.[0]).filter(Boolean))];
  assert.ok(source.includes(proof.excerpt)||margins.some(margin=>source.includes(proof.excerpt.split('\n').map(line=>margin+line).join('\n'))),'Support quote must match exact source bytes.');
 }
}
const sdk=new PiSdkRuntime();
const runtime={async runSession(options){const observe=options.onEvent;return sdk.runSession({...options,systemPrompt:options.systemPrompt+" A supported checklist alone is insufficient: give one short exact-source support_evidence entry per assigned ID. Explain the entire claim including conditional and quantified clauses. If a clause contradicts the source, return unsupported rather than manufacturing a support proof.",customTools:options.customTools?.map(tool=>({...tool,parameters:supportParameters(tool.parameters),async execute(...args){validateSupport(args[1],JSON.parse(options.userPrompt));const {support_evidence,...canonical}=args[1];const result=await tool.execute(args[0],canonical,...args.slice(2));if(tool.name==='submit_specialist_review')acceptedSubmissions.push({...structuredClone(args[1]),assigned_claim_ids:Object.keys(JSON.parse(options.userPrompt).claims),finding_claim_value:JSON.parse(options.userPrompt).claims[args[1].finding?.claim]??null});return result;}})),onEvent(event){if(event.type==='message_update'){stream.updates++;stream.first_update_ms??=Date.now()-started;stream.last_update_ms=Date.now()-started;const type=event.assistantMessageEvent?.type??'unknown';stream.types[type]=(stream.types[type]??0)+1;}observe?.(event);}});}};
process.env.MINIMAX_API_KEY=process.env.PI_API_KEY;
const output=await reviewSpecialistCompilation({cwd,runtime,config:MODEL_CONFIG,
 ui:{status(){}},auditLog:{recordMessageEnd(){},sessionEvent(value){
  const e=value.event;
  if(e?.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,toolName:e.toolName,isError:e.isError,feedback:e.isError?JSON.stringify(e.result).slice(0,2200):undefined});
  if(e?.type==='message_end'&&e.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:'message_end',stopReason:e.message.stopReason,errorMessage:e.message.errorMessage});
 }}},compilation,budget,'explicit-verdict-live-'+selected.name);
const record=output.map.specialist_reviews?.records.find(r=>r.concern===selected.concern);
const retired=output.map.concern_evidence?.not_concerns.some(r=>r.candidate===selected.concern)&&!output.map.concern_evidence?.concerns.some(r=>r.concern===selected.concern);
const result={candidate_sha:candidate,thinking_configuration_experiment:"high",serial_comparison:true,approval_evidence_experiment:true,production_review_gates_unchanged:true,case:selected,component_only:true,production_prompt_unchanged:true,native_terminal_selection:true,fresh_installation:false,installation_credit:false,original_body_digest:originalDigest,submitted_body_digest:submittedBodyDigest,false_claim_canary:selected.false_claim_canary===true,accepted_submissions:acceptedSubmissions,canary_rejected:!selected.false_claim_canary||acceptedSubmissions.some(v=>v.verdict==='unsupported'&&v.finding?.claim==='pitfalls[0]'&&v.finding?.path==='jwt/api_jwt.py'),elapsed_ms:Date.now()-started,production_budget_overrides:false,usage:budget.snapshot(),stream,events,review:record??null,serialized_live_probe:true,retired_after_source_review:retired===true,valid_typed_outcome:record?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')===''};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);if(selected.false_claim_canary)assert.ok(result.canary_rejected,'false numeric-expiry canary was not explicitly rejected');else assert.ok(result.valid_typed_outcome,'bounded review did not reach an explicit typed outcome');
