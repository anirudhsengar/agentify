import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {supportParameters,normalizeReviewReport,encodedClaims} from './support-protocol.mjs';
import {proofEnvelopeSchema,parseProofEnvelope} from './proof-envelope.mjs';
const root=process.cwd();
const resolveRoot=specifier=>execFileSync(process.execPath,['--input-type=module','-e','process.stdout.write(import.meta.resolve(process.argv[1]))',specifier],{cwd:root,encoding:'utf8'});
const {defineTool}=await import(resolveRoot('@earendil-works/pi-coding-agent'));
const {Value}=await import(resolveRoot('typebox/value'));
const {PiSdkRuntime}=await import(pathToFileURL(path.join(root,'src/core/pi-sdk-runtime.ts')).href);
const {createSpecialistReviewSubmissionSchema}=await import(pathToFileURL(path.join(root,'src/core/audit/schema/specialist-review.ts')).href);
const {createReadOnlyExecutionPolicy}=await import(pathToFileURL(path.join(root,'src/core/security/execution-policy.ts')).href);
const data={claims:{'invariants[4]':'The predicate returns true for a stored record.','validation':[]},evidence:{'cache.py':'def present(record):\n    return record is not None\n'}};
const citation={source:0,start_line:2,end_line:2,reason:'The return expression tests the record against None.'};
for(const kind of ['supported','unsupported','canonical-id','missing-claim','malformed-json','extra-envelope-field','extra-report-field']){
 test('actual MiniMax SDK JSON review envelope: '+kind,async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agentify-proof-sdk-'));
  const payloads=[];const outcomes=[];let canonical;let calls=0;const stop=new AbortController();
  const proposal=kind==='unsupported'?{verdict:'unsupported',finding:{claim:'C000',...citation}}:
   {verdict:'supported',support:kind==='missing-claim'?{C000:citation}:kind==='canonical-id'?{'invariants[4]':citation,C001:true}:{C000:citation,C001:true}};
  const server=createServer(async(request,response)=>{
   const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
   payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   response.writeHead(200,{'Content-Type':'text/event-stream'});
   const body=kind==='extra-report-field'?{...proposal,unexpected:true}:proposal;
   const envelope={report_json:kind==='malformed-json'?'{':JSON.stringify(body),...(kind==='extra-envelope-field'?{unexpected:true}:{})};
   const args=JSON.stringify(envelope);const middle=Math.floor(args.length/2);
   const stream=[
    ['message_start',{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:'MiniMax-M3',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'review-proof',name:'submit_specialist_review',input:{}}}],
    ...[args.slice(0,middle),args.slice(middle)].map(partial_json=>['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json}}]),
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:40}}],
    ['message_stop',{type:'message_stop'}],
   ];
   response.end(stream.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join(''));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();assert.ok(address&&typeof address==='object');
   fs.writeFileSync(path.join(cwd,'models.json'),JSON.stringify({providers:{minimax:{baseUrl:'http://127.0.0.1:'+address.port,api:'anthropic-messages',apiKey:'local-test-placeholder',models:[{id:'MiniMax-M3',reasoning:true,contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
   const originalSchema=createSpecialistReviewSubmissionSchema(Object.keys(data.claims));
   const base=defineTool({name:'submit_specialist_review',label:'review',description:'Record the exact source decision.',parameters:originalSchema,async execute(id,report){
    assert.ok(Value.Check(originalSchema,report));
    if(report.verdict==='supported')assert.deepEqual([...report.checked_claims].sort(),Object.keys(data.claims).sort());
    else {assert.equal(report.finding.claim,'invariants[4]');assert.equal(report.finding.excerpt,'    return record is not None');}
    canonical=report;stop.abort();return {content:[{type:'text',text:'accepted'}],details:{}};
   }});
   const tool={...base,parameters:proofEnvelopeSchema,async execute(id,input,...rest){return base.execute(id,parseProofEnvelope(input,originalSchema,data,Value).canonical,...rest);}};
   const result=await new PiSdkRuntime().runSession({cwd,configDir:cwd,config:{schemaVersion:1,thinkingLevel:'high',models:{primary:{provider:'minimax',model:'MiniMax-M3'}}},
    systemPrompt:'Local deterministic review transport fixture.',userPrompt:JSON.stringify(encodedClaims(data)),
    tools:[tool.name],customTools:[tool],signal:stop.signal,timeoutMs:5000,maxOutputTokens:4096,
    forceRequiredToolChoice:true,recoveryPromptIfToolNotCalled:{requiredToolName:tool.name,userPrompt:'submit',maxAttempts:0},
    onProviderRequest(){assert.equal(++calls,1,'invalid proof cannot trigger another HTTP request');},
    onEvent(event){if(event.type==='tool_execution_end'){outcomes.push(event);stop.abort();}},
    executionPolicy:createReadOnlyExecutionPolicy({cwd,mode:'audit-readonly',tools:[]})});
   assert.equal(payloads.length,1);assert.equal(result.aborted,true);
   const schema=payloads[0].tools.find(t=>t.name===tool.name).input_schema;
   assert.deepEqual(Object.keys(schema.properties),['report_json']);
   assert.equal(payloads[0].thinking.type,'enabled');
   assert.deepEqual(payloads[0].tool_choice,{type:'tool',name:tool.name});
   assert.match(JSON.stringify(payloads[0].messages),/C000/);
   if(kind==='supported'||kind==='unsupported')assert.equal(canonical.verdict,kind);
   else {assert.equal(canonical,undefined);assert.ok(outcomes.some(e=>e.isError));}
  } finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cwd,{recursive:true,force:true});}
 });
}
