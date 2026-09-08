import assert from 'node:assert/strict';
export function verifyBalancedAssignments(result){
 const groups=new Map();
 for(const task of result.review_tasks??[]){
  if(!task.assignment)continue;
  const a=task.assignment;assert.match(a.body_digest,/^[a-f0-9]{64}$/);
  assert.ok(a.index===0||a.index===1);assert.equal(task.thinking_level,'high');assert.equal(task.output_cap,12000);
  assert.ok(task.timeout_ms>0&&task.timeout_ms<=90000);
  const ids=task.claim_ids;const all=a.all_claim_ids;assert.equal(new Set(ids).size,ids.length);assert.equal(new Set(all).size,all.length);
  assert.deepEqual([...ids].sort(),[...a.required_checked_claim_ids].sort());assert.ok(ids.every(id=>all.includes(id)));
  assert.ok(Object.keys(task.source_digests).length>0);for(const hash of Object.values(task.source_digests))assert.match(hash,/^[a-f0-9]{64}$/);
  const group=groups.get(a.body_digest)??new Map();
  if(group.has(a.index))assert.deepEqual(group.get(a.index).assignment,a,'retry must preserve exact assignment identity');
  group.set(a.index,task);groups.set(a.body_digest,group);
 }
 assert.ok(groups.size>0,'the complete-review assignment path must execute');
 for(const group of groups.values()){
  assert.deepEqual([...group.keys()].sort(),[0,1],'a complete body requires both assignments');
  const left=group.get(0),right=group.get(1);
  assert.deepEqual(left.source_digests,right.source_digests,'both assignments require identical complete immutable source');
  assert.deepEqual(left.assignment.scope,right.assignment.scope,'coherence context must be identical');
  assert.deepEqual(left.assignment.all_claim_ids,right.assignment.all_claim_ids);
  assert.deepEqual([...new Set([...left.claim_ids,...right.claim_ids])].sort(),[...left.assignment.all_claim_ids].sort());
  assert.deepEqual(left.claim_ids.filter(id=>right.claim_ids.includes(id)).sort(),['concern','covers','excludes']);
 }
}
