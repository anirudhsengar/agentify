import assert from 'node:assert/strict';
export function verifySourceFirstTasks(result){
 const tasks=result.review_tasks??[];const notes=tasks.filter(task=>task.source_observation);
 const full=tasks.filter(task=>!task.source_observation&&!task.source_precheck&&task.claim_ids?.length>0);
 assert.ok(notes.length>0&&full.length>0,'source-only reading cannot substitute for complete review');
 for(const task of tasks){assert.equal(task.thinking_level,'high');assert.equal(task.output_cap,12000);assert.ok(task.timeout_ms>0&&task.timeout_ms<=90000);}
 for(const task of notes)assert.deepEqual(task.claim_ids,[],'source-only reader must not see proposed claims');
 assert.ok((result.accepted_observations??[]).length>0,'notes must cross the actual validated source terminal');
 for(const report of result.accepted_observations){
  assert.ok(Array.isArray(report.observations)&&report.observations.length<=4);
  assert.equal(report.verdict,undefined,'source observations have no verdict authority');
  for(const note of report.observations){assert.ok(Number.isInteger(note.start_line)&&note.start_line>=1&&Number.isInteger(note.end_line)&&note.end_line>=note.start_line);assert.equal(typeof note.path,'string');assert.equal(typeof note.behavior,'string');}
 }
 for(const task of full){assert.ok(Array.isArray(task.untrusted_source_observations));assert.ok(task.claim_ids.includes('validation'));}
 assert.ok(tasks.indexOf(notes[0])<tasks.indexOf(full[0]),'source reading precedes complete review');
 assert.ok(result.accepted_submissions?.length>0,'only a complete original review is a typed outcome');
}
