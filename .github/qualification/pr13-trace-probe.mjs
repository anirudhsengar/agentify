import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd();const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {createSpawnExplorerTool}=await load('src/core/audit/spawn-explorer-tool.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {createAgentifyModelRuntime}=await load('src/core/pi-credential-store.ts');
const {setThinkingLevel}=await load('src/core/audit/state.ts');
const {redactSecrets}=await load('scripts/live-installation.mjs');
const {createAgentSession}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const candidate='04ebc3b9273aa203fc00407c646338f4c5ef2236';assert.equal(git(root,'rev-parse','HEAD'),candidate);
const cwd=process.env.PROBE_TARGET,out=process.env.PROBE_EVIDENCE,agentDir=process.env.PROBE_HOME;
assert.ok(cwd&&out&&agentDir&&process.env.PI_API_KEY);
assert.equal(git(cwd,'rev-parse','HEAD'),'e2740d5a1bd0b4254e517e3af8b60789284bc7bd');assert.equal(git(cwd,'status','--porcelain'),'');
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(agentDir,{recursive:true});
const {modelRuntime}=await createAgentifyModelRuntime({authFile:path.join(agentDir,'auth.json'),modelsFile:path.join(agentDir,'models.json'),runtimeApiKey:{provider:'minimax',key:process.env.PI_API_KEY}});
const model=modelRuntime.getModel('minimax','MiniMax-M3');assert.ok(model);setThinkingLevel('high');
const budget=new AuditResourceBudget(),started=Date.now(),events=[];
const explorer=createSpawnExplorerTool({agentDir,stateDir:'.agentify/runtime/audit',explorerModel:model,resourceBudget:budget,
 createSession:async options=>{
  const made=await createAgentSession({...options,modelRuntime});
  made.session.subscribe(event=>{
   if(event.type==='message_end'&&event.message?.role==='assistant')events.push({elapsed_ms:Date.now()-started,type:event.type,stopReason:event.message.stopReason,usage:event.message.usage,errorMessage:event.message.errorMessage});
   if(event.type==='tool_execution_end')events.push({elapsed_ms:Date.now()-started,type:event.type,toolName:event.toolName,isError:event.isError,feedback:event.isError?JSON.stringify(event.result).slice(0,3000):undefined});
  });return made;
 }
});
const result=await explorer.execute('live-trace-probe',{mode:'concern_tracer',target_path:'src/router',concern:'Route matching',focus:'Trace path-and-method matching through src/router/smart-router/router.ts, src/router/reg-exp-router/router.ts, and src/router/trie-router/router.ts, including selection and fallback invariants.'},undefined,undefined,{cwd});
const report={candidate_sha:candidate,target_sha:git(cwd,'rev-parse','HEAD'),model:'minimax/MiniMax-M3',thinking:'high',component_only:true,installation_credit:false,production_budget_overrides:false,elapsed_ms:Date.now()-started,source_unchanged:git(cwd,'status','--porcelain')==='',usage:budget.snapshot(),events,result};
const clean=text=>redactSecrets(text,[process.env.PI_API_KEY]);
fs.writeFileSync(path.join(out,'trace-probe.json'),clean(JSON.stringify(report,null,2))+'\n');
console.log(clean(JSON.stringify({candidate_sha:candidate,component_only:true,elapsed_ms:report.elapsed_ms,usage:report.usage,events,error:result.isError===true},null,2)));
assert.ok(report.source_unchanged);if(result.isError)process.exitCode=1;
