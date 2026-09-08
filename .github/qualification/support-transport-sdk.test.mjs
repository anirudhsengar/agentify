import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {supportParameters,normalizeReviewReport,encodedClaims} from './support-protocol.mjs';
const root=process.cwd();
const resolveRoot=specifier=>execFileSync(process.execPath,['--input-type=module','-e','process.stdout.write(import.meta.resolve(process.argv[1]))',specifier],{cwd:root,encoding:'utf8'});
const {defineTool}=await import(resolveRoot('@earendil-works/pi-coding-agent'));
const {Value}=await import(resolveRoot('typebox/value'));
const {PiSdkRuntime}=await import(pathToFileURL(path.join(root,'src/core/pi-sdk-runtime.ts')).href);
const {createSpecialistReviewSubmissionSchema}=await import(pathToFileURL(path.join(root,'src/core/audit/schema/specialist-review.ts')).href);
const {createReadOnlyExecutionPolicy}=await import(pathToFileURL(path.join(root,'src/core/security/execution-policy.ts')).href);
const data={claims:{'invariants[4]':'The predicate returns true for a stored record.','validation':[]},evidence:{'cache.py':'def present(record):\n    return record is not None\n'}};
const citation={source:0,start_line:2,end_line:2,reason:'The return expression tests the record against None.'};
for(const kind of ['supported','unsupported','canonical-id','missing-claim']){
 test('actual SDK opaque review transport: '+kind,async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agentify-proof-sdk-'));
  const payloads=[];const outcomes=[];let canonical;let calls=0;const stop=new AbortController();
  const proposal=kind==='unsupported'?{verdict:'unsupported',finding:{claim:'C000',...citation}}:
   {verdict:'supported',support:kind==='missing-claim'?{C000:citation}:kind==='canonical-id'?{'invariants[4]':citation,C001:true}:{C000:citation,C001:true}};
  const server=createServer(async(request,response)=>{
   const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   response.writeHead(200,{'Content-Type':'text/event-stream'});
   response.end('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'review-proof',type:'function',function:{name:'submit_specialist_review',arguments:JSON.stringify(proposal)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();assert.ok(address&&typeof address==='object');
   fs.writeFileSync(path.join(cwd,'models.json'),JSON.stringify({providers:{openai:{baseUrl:'http://127.0.0.1:'+address.port+'/v1',api:'openai-completions',apiKey:'local-test-placeholder',models:[{id:'proof-fixture',contextWindow:32768,maxTokens:256,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
   const originalSchema=createSpecialistReviewSubmissionSchema(Object.keys(data.claims));
   const base=defineTool({name:'submit_specialist_review',label:'review',description:'Record the exact source decision.',parameters:originalSchema,async execute(id,report){
    assert.ok(Value.Check(originalSchema,report));
    if(report.verdict==='supported')assert.deepEqual([...report.checked_claims].sort(),Object.keys(data.claims).sort());
    else {assert.equal(report.finding.claim,'invariants[4]');assert.equal(report.finding.excerpt,'    return record is not None');}
    canonical=report;stop.abort();return {content:[{type:'text',text:'accepted'}],details:{}};
   }});
   const tool={...base,parameters:supportParameters(originalSchema,data),async execute(id,report,...rest){return base.execute(id,normalizeReviewReport(report,data),...rest);}};
   const result=await new PiSdkRuntime().runSession({cwd,configDir:cwd,config:{schemaVersion:1,thinkingLevel:'off',models:{primary:{provider:'openai',model:'proof-fixture'}}},
    systemPrompt:'Local deterministic review transport fixture.',userPrompt:JSON.stringify(encodedClaims(data)),
    tools:[tool.name],customTools:[tool],signal:stop.signal,timeoutMs:5000,maxOutputTokens:256,
    forceRequiredToolChoice:true,recoveryPromptIfToolNotCalled:{requiredToolName:tool.name,userPrompt:'submit',maxAttempts:0},
    onProviderRequest(){assert.equal(++calls,1,'invalid proof cannot trigger another HTTP request');},
    onEvent(event){if(event.type==='tool_execution_end'){outcomes.push(event);stop.abort();}},
    executionPolicy:createReadOnlyExecutionPolicy({cwd,mode:'audit-readonly',tools:[]})});
   assert.equal(payloads.length,1);assert.equal(result.aborted,true);
   const schema=payloads[0].tools.find(t=>t.function.name===tool.name).function.parameters;
   assert.deepEqual(Object.keys(schema.properties.support.properties),['C000','C001']);
   assert.match(JSON.stringify(payloads[0].messages),/C000/);
   if(kind==='supported'||kind==='unsupported')assert.equal(canonical.verdict,kind);
   else {assert.equal(canonical,undefined);assert.ok(outcomes.some(e=>e.isError));}
  } finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cwd,{recursive:true,force:true});}
 });
}
