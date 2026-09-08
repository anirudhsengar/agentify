import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const {EXPECTED_CANDIDATE:candidate,EXPECTED_TREE:tree,EXPECTED_LAUNCHER:launcher,RUNNER_TEMP:temp}=process.env;
const run=JSON.parse(fs.readFileSync(path.join(temp,'qualification.json'),'utf8'));
assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');assert.equal(run.head_sha,launcher);assert.equal(run.run_attempt,1);
const root=path.join(temp,'qualified-source');let digest;
for(const node of ['22.19.0','24.19.0']){
 const dir=path.join(root,'node-'+node);const env=fs.readFileSync(path.join(dir,'pr13-review-r8-environment.txt'),'utf8');
 assert.ok(env.includes('candidate='+candidate+'\n'));assert.ok(env.includes('tree='+tree+'\n'));
 assert.ok(env.includes('v'+node+'\n11.19.0\n'));assert.equal(fs.readFileSync(path.join(dir,'pr13-review-r8-qualification.exit'),'utf8').trim(),'0');
 const log=fs.readFileSync(path.join(dir,'pr13-review-r8-qualification.log'),'utf8');
 const hashes=[...log.matchAll(/exact installed artifact qualification passed \([^,]+, ([a-f0-9]{64}), [0-9]+ entries\)/g)].map(m=>m[1]);
 assert.ok(hashes.length>0);assert.equal(new Set(hashes).size,1);
 if(digest)assert.equal(hashes[0],digest);digest=hashes[0];
}
for(const name of ['r8-high-jwk','r8-high-valid-cache','r8-numeric-exp-canary']){
 const result=JSON.parse(fs.readFileSync(path.join(temp,'source-controls',name,'review-probe.json'),'utf8'));
 assert.equal(result.candidate_sha,candidate);assert.equal(result.candidate_tree,tree);assert.equal(result.source_unchanged,true);
 assert.equal(result.valid_typed_outcome,true);assert.equal(result.production_budget_overrides,false);
 if(name==='r8-high-valid-cache'){assert.equal(result.positive_control_passed,true);assert.equal(result.review.failure,null);}
 if(name==='r8-high-jwk'){
  assert.equal(result.known_bad_body_approved,false);assert.ok(result.review_tasks.some(task=>task.source_precheck));
  assert.ok(result.accepted_submissions.some(s=>[s.finding,...s.additional_findings??[]].some(f=>f?.claim==='invariants[4]'&&f.path==='jwt/jwk_set_cache.py')),'Known cache contradiction must be explicitly found.');
 }
 if(name==='r8-numeric-exp-canary'){assert.equal(result.false_claim_canary,true);assert.equal(result.canary_rejected,true);}
}
fs.appendFileSync(process.env.GITHUB_ENV,'LIVE_EXPECTED_PACKAGE_HASH='+digest+'\n');
fs.writeFileSync(path.join(temp,'review-r8-qualification-reuse.json'),JSON.stringify({candidate,tree,qualification_run:run.id,launcher,package_sha256:digest,code_nodes:['22.19.0','24.19.0'],source_controls:3},null,2)+'\n');
console.log('Exact code, source controls, and package identity verified: '+digest);
