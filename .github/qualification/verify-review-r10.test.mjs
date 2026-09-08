import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import test from 'node:test';import {spawnSync} from 'node:child_process';
const candidate='a'.repeat(40),tree='b'.repeat(40),launcher='c'.repeat(40),digest='d'.repeat(64);
for(const scenario of ['valid','source','tree','node','qualification-failed','wrong-producer','wrong-artifact','unreviewed','canary-missed','source-changed']){
 test('exact-candidate installation evidence gate: '+scenario,()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pr13-evidence-gate-'));
  const write=(file,data)=>{const full=path.join(temp,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,data);};
  try{
   write('qualification.json',JSON.stringify({id:34237230441,status:'completed',conclusion:scenario==='qualification-failed'?'failure':'success',head_sha:scenario==='wrong-producer'?'e'.repeat(40):launcher,run_attempt:1}));
   for(const node of ['22.19.0','24.19.0']){
    const root='qualified-source/node-'+node+'/pr13-readable-review-r10-code-';
    write(root+'environment.txt','candidate='+(scenario==='source'?'e'.repeat(40):candidate)+'\ntree='+(scenario==='tree'?'e'.repeat(40):tree)+'\nv'+(scenario==='node'?'20.0.0':node)+'\n11.19.0\n');
    write(root+'qualification.exit','0\n');
    write(root+'qualification.log','exact installed artifact qualification passed (fixture, '+(scenario==='wrong-artifact'&&node==='24.19.0'?'f'.repeat(64):digest)+', 52 entries)');
   }
   for(const name of ['r10-high-jwk','r10-high-valid-cache','r10-numeric-exp-canary']){
    const value={candidate_sha:candidate,candidate_tree:tree,source_unchanged:scenario!=='source-changed',valid_typed_outcome:scenario!=='unreviewed',production_budget_overrides:false,
      positive_control_passed:true,review:{failure:null},known_bad_body_approved:false,review_tasks:[{source_precheck:true}],
      accepted_submissions:[{finding:{claim:'invariants[4]',path:'jwt/jwk_set_cache.py'}}],false_claim_canary:true,canary_rejected:scenario!=='canary-missed'};
    write('source-controls/'+name+'/review-probe.json',JSON.stringify(value));
   }
   const envFile=path.join(temp,'environment');
   const run=spawnSync(process.execPath,[new URL('./verify-review-r10.mjs',import.meta.url).pathname],{env:{...process.env,RUNNER_TEMP:temp,EXPECTED_CANDIDATE:candidate,EXPECTED_TREE:tree,EXPECTED_LAUNCHER:launcher,GITHUB_ENV:envFile},encoding:'utf8',timeout:5000});
   assert.equal(run.status===0,scenario==='valid',run.stderr);
   if(scenario==='valid')assert.equal(fs.readFileSync(envFile,'utf8'),'LIVE_EXPECTED_PACKAGE_HASH='+digest+'\n');
   else assert.equal(fs.existsSync(envFile),false,'failed provenance may not authorize any package');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
 });
}
