import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createClaimProofTool} from './claim-proof-tool.mjs';

const root=process.cwd();const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {Value}=await import(execFileSync(process.execPath,['--input-type=module','-e',"process.stdout.write(import.meta.resolve('typebox/value'))"],{cwd:root,encoding:'utf8'}));
const {PiSdkRuntime}=await load('src/core/pi-sdk-runtime.ts');
const {AuditResourceBudget}=await load('src/core/audit/resource-budget.ts');
const {compileSpecialistEvidence}=await load('src/core/audit/specialist-compiler.ts');
const {reviewSpecialistCompilation}=await load('src/core/audit/specialist-review.ts');
const {makeValidCodebaseMap}=await load('tests/fixtures/codebase-map.ts');
const {readReviewPrompt}=await load('tests/fixtures/review-prompt.ts');
const source='def convert(value):\n    return int(value)\n';
for(const outcome of ['batch-supported','corrected','rejected-twice','prose-only','unsupported','false-quote','empty-not-acknowledged']){
 test('actual native SDK claim batches preserve the controller budget: '+outcome,async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agentify-proof-correction-'));let data;let calls=0;const errors=[];const sdkCalls=[];

  const server=createServer(async(request,response)=>{
   for await(const _ of request){};
   calls++;
   const codes=Object.keys(data.claims).map(id=>[id,id]);
   const selected=outcome==='batch-supported'?codes:outcome==='corrected'?(calls===1?codes.slice(0,-1):codes.slice(-1)):codes.slice(calls-1,calls);
   const records=selected.map(([claim,id])=>{const empty=Array.isArray(data.claims[id])&&data.claims[id].length===0;return {claim,verdict:'supported',path:empty?'':'clock.py',excerpt:empty?'':'return int(value)',reason:'The immutable return statement converts the input with int().'};});
   if(outcome==='unsupported'){records.splice(0,records.length,{claim:'one_line',verdict:'unsupported',path:'clock.py',excerpt:'return int(value)',reason:'The function converts the value rather than returning it unchanged.'});}
   if(outcome==='false-quote')records.forEach(r=>{r.path='clock.py';r.excerpt='return None';});
   if(outcome==='empty-not-acknowledged')records.splice(0,records.length,{claim:'validation',verdict:'supported',path:'clock.py',excerpt:'return int(value)',reason:'An empty list is not a command.'});
   const events=[['message_start',{type:'message_start',message:{id:'fixture-'+calls,type:'message',role:'assistant',model:'MiniMax-M3',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}}]];
   if(outcome==='prose-only')events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Unstructured prose does not authorize approval.'}}],['content_block_stop',{type:'content_block_stop',index:0}]);
   else records.forEach((record,index)=>events.push(['content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:'review-'+calls+'-'+index,name:'submit_specialist_review',input:{}}}],
    ['content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(record)}}],['content_block_stop',{type:'content_block_stop',index}]));
   events.push(['message_delta',{type:'message_delta',delta:{stop_reason:outcome==='prose-only'?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:40}}],['message_stop',{type:'message_stop'}]);
   response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(events.map(([event,payload])=>'event: '+event+'\ndata: '+JSON.stringify(payload)+'\n\n').join(''));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   fs.writeFileSync(path.join(cwd,'clock.py'),source);
   for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','immutable conversion']])execFileSync('git',args,{cwd,stdio:'pipe'});
   const address=server.address();assert.ok(address&&typeof address==='object');
   fs.writeFileSync(path.join(cwd,'models.json'),JSON.stringify({providers:{minimax:{baseUrl:'http://127.0.0.1:'+address.port,api:'anthropic-messages',apiKey:'local-test-placeholder',models:[{id:'MiniMax-M3',reasoning:true,contextWindow:32768,maxTokens:12000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
   const body={concern:'Integer conversion',one_line:'Converts inputs with int().',covers:'Local input conversion.',excludes:'Clock sampling and scheduling.',
    flows:[{name:'Convert input',description:'Return integer conversion.',steps:[{path:'clock.py',what_happens:'convert receives the value.'},{path:'clock.py',what_happens:'Return int(value).'}]}],
    touchpoints:[{path:'clock.py',symbol:'convert',role:'Converts the input.',centrality:'core',line_range:null}],
    invariants:[{rule:'Conversion is returned.',why:'The return expression calls int().',reference:'clock.py'}],pitfalls:[],entry_questions:['Does this change affect integer conversion?'],validation:[],spans_subtrees:[],stability:'high',recurrence:'high',confidence:'high',last_updated:'2026-09-08T00:00:00.000Z'};
   const compiled=compileSpecialistEvidence(makeValidCodebaseMap({concern_evidence:{concerns:[body],not_concerns:[]},expert_evidence:undefined}),{cwd});
   assert.ok(compiled.assessment.accepted_concerns.includes(body.concern));
   const budget=new AuditResourceBudget();const sdk=new PiSdkRuntime();
   const runtime={async runSession(options){data=readReviewPrompt(options.userPrompt);assert.equal(options.maxOutputTokens,12000);
    const tools=options.customTools.map(original=>createClaimProofTool(original,data,Value));
    return sdk.runSession({...options,configDir:cwd,forceRequiredToolChoice:false,customTools:tools.map(t=>t.tool),onEvent(event){
     if(event.type==='tool_execution_start')sdkCalls.push({id:event.toolCallId,args:event.args});
     tools.forEach(t=>t.observe(event));options.onEvent?.(event);}});}};
   const result=await reviewSpecialistCompilation({cwd,runtime,ui:{status(){}},config:{schemaVersion:1,thinkingLevel:'high',models:{primary:{provider:'minimax',model:'MiniMax-M3'}}},
    auditLog:{recordMessageEnd(){},sessionEvent({event}){if(event?.type==='tool_execution_end'&&event.isError)errors.push(event);}}},compiled,budget,'native-proof-correction');
   const record=result.map.specialist_reviews.records.find(r=>r.concern===body.concern);
   assert.equal(calls,['prose-only','batch-supported','unsupported'].includes(outcome)?1:2,'only one actual argument correction may reach HTTP');
   assert.equal(budget.snapshot().model_calls,calls);assert.equal(budget.snapshot().unreserved_calls,0);
   assert.equal(record.failure===null,outcome==='corrected'||outcome==='batch-supported');
   if(!['corrected','batch-supported','unsupported'].includes(outcome))assert.equal(record.retryable,true);
   if(outcome==='unsupported'){assert.equal(record.retryable,false);assert.equal(record.finding.claim,'one_line');}
   assert.equal(errors.length,['prose-only','batch-supported','unsupported'].includes(outcome)?0:outcome==='corrected'?1:2);
   assert.equal(execFileSync('git',['show','HEAD:clock.py'],{cwd,encoding:'utf8'}),source);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cwd,{recursive:true,force:true});}
 });
}
