import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const load=(relative)=>import(pathToFileURL(path.join(root,relative)).href);
const {createSpawnExplorerTool}=await load('src/core/audit/spawn-explorer-tool.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {createAgentifyModelRuntime}=await load('src/core/pi-credential-store.ts');
const {setThinkingLevel}=await load('src/core/audit/state.ts');
const {createAgentSession}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const candidate='cd24d0fa2da079a1c0ab8d659cff508d5fc988c1';
assert.equal(git(root,'rev-parse','HEAD'),candidate);
const cwd=process.env.PROBE_TARGET, out=process.env.PROBE_EVIDENCE, agentDir=process.env.PROBE_HOME;
assert.ok(cwd&&out&&agentDir&&process.env.PI_API_KEY);
assert.equal(git(cwd,'rev-parse','HEAD'),'e2740d5a1bd0b4254e517e3af8b60789284bc7bd');
assert.equal(git(cwd,'status','--porcelain'),'');
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(agentDir,{recursive:true});
const {modelRuntime}=await createAgentifyModelRuntime({authFile:path.join(agentDir,'auth.json'),modelsFile:path.join(agentDir,'models.json'),runtimeApiKey:{provider:'minimax',key:process.env.PI_API_KEY}});
const model=modelRuntime.getModel('minimax','MiniMax-M3');assert.ok(model);
setThinkingLevel('high');
const budget=new AuditResourceBudget();const controller=new AbortController();
const started=Date.now();let triggeredAt=null,trigger=null;const counts={};
const watchdog=setTimeout(()=>controller.abort(),180000);
const explorer=createSpawnExplorerTool({agentDir,stateDir:'.agentify/runtime/audit',explorerModel:model,resourceBudget:budget,
 createSession:async(options)=>{
  const created=await createAgentSession({...options,modelRuntime});
  created.session.subscribe(event=>{
   counts[event.type]=(counts[event.type]??0)+1;
   // A streamed assistant update or completed response proves a real provider response.
   if(triggeredAt===null&&(event.type==='message_update'||event.type==='message_end'&&event.message?.role==='assistant')){
    triggeredAt=Date.now();trigger=event.type;controller.abort();
   }
  });return created;
 }
});
try{
 const result=await explorer.execute('live-cancel',{mode:'concern_tracer',target_path:'src/router',concern:'Route matching',focus:'Trace SmartRouter selection and fallback from src/router/smart-router/router.ts.'},controller.signal,undefined,{cwd});
 const elapsed=Date.now()-started;const cancellationMs=triggeredAt===null?null:Date.now()-triggeredAt;const usage=budget.snapshot();
 const checks={actual_response:triggeredAt!==null,failed_receipt:result.isError===true,no_repository_writes:git(cwd,'status','--porcelain')==='',cancelled_promptly:cancellationMs!==null&&cancellationMs<5000,accounted_calls:usage.model_calls>0,no_unreserved_calls:usage.unreserved_calls===0,unanswered_calls_reserved:usage.unreported_calls===0||(usage.reserved_input_tokens>0&&usage.reserved_output_tokens>0&&usage.reserved_cost_usd>0)};
 const report={candidate_sha:candidate,target_sha:git(cwd,'rev-parse','HEAD'),model:'minimax/MiniMax-M3',thinking:'high',component_only:true,installation_credit:false,production_budget_overrides:false,trigger,elapsed_ms:elapsed,cancellation_ms:cancellationMs,event_counts:counts,usage,checks,passed:Object.values(checks).every(Boolean),provider_invoice_reconciled:false};
 fs.writeFileSync(path.join(out,'cancellation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 assert.ok(report.passed,'live cancellation or conservative accounting failed');
}finally{clearTimeout(watchdog);}
