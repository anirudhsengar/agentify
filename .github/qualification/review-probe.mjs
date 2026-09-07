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
const candidate='6a6678abbca8acf4d2dc2e81376e0b50faf2d624';assert.equal(git(root,'rev-parse','HEAD'),candidate);
assert.equal(git(cwd,'rev-parse','HEAD'),selected.target_sha);assert.equal(git(cwd,'status','--porcelain'),'');
function find(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const f=path.join(directory,e.name);return e.isDirectory()?find(f):e.isFile()&&e.name==='codebase_map.json'?[f]:[];});}
const files=find(process.env.PROBE_PREVIOUS);assert.equal(files.length,1);
const bytes=fs.readFileSync(files[0]);assert.equal(createHash('sha256').update(bytes).digest('hex'),selected.map_sha256);
const map=JSON.parse(bytes);const body=map.concern_evidence.concerns.find(c=>c.concern===selected.concern);assert.ok(body);
const originalDigest=specialistReviewDigest(body);
// Re-review the unchanged, captured body; this controlled input is not a fresh installation.
map.concern_evidence.concerns=[body];delete map.specialist_reviews;
const compilation=compileSpecialistEvidence(map,{cwd});assert.ok(compilation.assessment.accepted_concerns.includes(selected.concern));
const budget=new AuditResourceBudget();const started=Date.now();const events=[];
process.env.MINIMAX_API_KEY=process.env.PI_API_KEY;
const output=await reviewSpecialistCompilation({cwd,runtime:new PiSdkRuntime(),config:MODEL_CONFIG,
 ui:{status(){}},auditLog:{recordMessageEnd(){},sessionEvent(value){
  const e=value.event;
  if(e?.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,toolName:e.toolName,isError:e.isError,feedback:e.isError?JSON.stringify(e.result).slice(0,2200):undefined});
  if(e?.type==='message_end'&&e.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:'message_end',stopReason:e.message.stopReason});
 }}},compilation,budget,'explicit-verdict-live-'+selected.name);
const record=output.map.specialist_reviews?.records.find(r=>r.concern===selected.concern);
const retired=output.map.concern_evidence?.not_concerns.some(r=>r.candidate===selected.concern)&&!output.map.concern_evidence?.concerns.some(r=>r.concern===selected.concern);
const result={candidate_sha:candidate,case:selected,component_only:true,fresh_installation:false,installation_credit:false,original_body_digest:originalDigest,elapsed_ms:Date.now()-started,production_budget_overrides:false,usage:budget.snapshot(),events,review:record??null,retired_after_source_review:retired===true,valid_typed_outcome:record?.retryable===false||retired===true,source_unchanged:git(cwd,'status','--porcelain')===''};
fs.mkdirSync(out,{recursive:true});const text=redactSecrets(JSON.stringify(result,null,2),[process.env.PI_API_KEY]);fs.writeFileSync(path.join(out,'review-probe.json'),text+'\n');console.log(text);
assert.ok(result.source_unchanged);assert.ok(result.valid_typed_outcome,'bounded review did not reach an explicit typed outcome');
