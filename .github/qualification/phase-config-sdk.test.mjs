import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServer} from 'node:http';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
import {reviewPhaseConfig} from './phase-config.mjs';
const root=process.cwd();const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {PiSdkRuntime}=await load('src/core/pi-sdk-runtime.ts');
const {createReadOnlyExecutionPolicy}=await load('src/core/security/execution-policy.ts');
const {Type}=await import(execFileSync(process.execPath,['--input-type=module','-e',"process.stdout.write(import.meta.resolve('typebox'))"],{cwd:root,encoding:'utf8'}));
const config={schemaVersion:1,provider:'minimax',thinkingLevel:'high',models:{primary:{provider:'minimax',model:'MiniMax-M3'},explorer:{provider:'minimax',model:'MiniMax-M3'}}};
test('phase config preserves all model assignments and does not mutate requested settings',()=>{
 const before=JSON.stringify(config);
 assert.equal(reviewPhaseConfig(config,true),config);
 assert.deepEqual(reviewPhaseConfig(config,false),{...config,thinkingLevel:'off'});
 assert.equal(JSON.stringify(config),before);
 assert.throws(()=>reviewPhaseConfig({...config,provider:'other'},false));
 assert.throws(()=>reviewPhaseConfig({...config,models:{primary:{provider:'minimax',model:'different-model'}}},false));
});
for(const precheck of [true,false]){
 test('actual native SDK phase configuration: '+precheck,async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agentify-review-phase-'));
  const payloads=[];
  const server=createServer(async(request,response)=>{
   const parts=[];for await(const part of request)parts.push(Buffer.from(part));
   payloads.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
   response.writeHead(400,{'Content-Type':'application/json'});
   response.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'phase wire fixture complete'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();assert.ok(address&&typeof address==='object');
   fs.writeFileSync(path.join(cwd,'models.json'),JSON.stringify({providers:{minimax:{baseUrl:'http://127.0.0.1:'+address.port,api:'anthropic-messages',apiKey:'local-test-placeholder',models:[{id:'MiniMax-M3',reasoning:true,contextWindow:32768,maxTokens:12000}]}}}));
   let calls=0;
   await assert.rejects(new PiSdkRuntime().runSession({cwd,configDir:cwd,config:reviewPhaseConfig(config,precheck),
    systemPrompt:'Local transport fixture.',userPrompt:'Check the fixture.',tools:['submit_specialist_review'],
    customTools:[{name:'submit_specialist_review',label:'Review',description:'Fixture only',parameters:Type.Object({}),async execute(){return {content:[],details:{}};}}],
    executionPolicy:createReadOnlyExecutionPolicy({cwd,tools:[]}),
    forceRequiredToolChoice:true,recoveryPromptIfToolNotCalled:{requiredToolName:'submit_specialist_review',maxAttempts:0,userPrompt:'Submit.'},
    onProviderRequest(){calls++;},maxOutputTokens:12000,timeoutMs:5000,
   }),/phase wire fixture complete/);
   assert.equal(calls,1);assert.equal(payloads.length,1);
   const wire=payloads[0];assert.equal(wire.model,'MiniMax-M3');assert.equal(wire.max_tokens,12000);assert.deepEqual(wire.tool_choice,{type:'auto'});
   if(precheck)assert.deepEqual(wire.thinking,{type:'adaptive'});
   else assert.ok(wire.thinking===undefined||wire.thinking?.type==='disabled','full stage must not request adaptive/enabled thinking');
   console.log(JSON.stringify({precheck,thinking:wire.thinking??null,model:wire.model,max_tokens:wire.max_tokens}));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cwd,{recursive:true,force:true});}
 });
}
