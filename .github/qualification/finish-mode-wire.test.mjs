import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
const {PiSdkRuntime}=await import(pathToFileURL(path.join(process.cwd(),'src/core/pi-sdk-runtime.ts')).href);
const {createReadOnlyExecutionPolicy}=await import(pathToFileURL(path.join(process.cwd(),'src/core/security/execution-policy.ts')).href);
for(const precheck of [true,false])test('source precheck and completion wire selection '+precheck,async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'agentify-finish-mode-'));const requests=[];
 const server=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));response.writeHead(400,{'Content-Type':'application/json'});
  response.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'wire fixture complete'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;
  fs.writeFileSync(path.join(cwd,'models.json'),JSON.stringify({providers:{minimax:{baseUrl:'http://127.0.0.1:'+port,api:'anthropic-messages',apiKey:'fixture-only',models:[{id:'MiniMax-M3',reasoning:true,contextWindow:32768,maxTokens:12000}]}}}));
  await assert.rejects(new PiSdkRuntime().runSession({cwd,configDir:cwd,config:{schemaVersion:1,thinkingLevel:precheck?'high':'off',models:{primary:{provider:'minimax',model:'MiniMax-M3'}}},
   systemPrompt:'Local wire fixture.',userPrompt:'Submit the source review.',tools:['submit_specialist_review'],customTools:[{name:'submit_specialist_review',label:'Review',description:'Fixture only.',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){throw new Error('No tool should execute in this HTTP fixture.');}}],
   executionPolicy:createReadOnlyExecutionPolicy({cwd,mode:'audit-readonly',tools:[]}),timeoutMs:5000,maxOutputTokens:12000,forceRequiredToolChoice:true,recoveryPromptIfToolNotCalled:{requiredToolName:'submit_specialist_review',userPrompt:'Submit.',maxAttempts:0}}),/wire fixture complete/);
  assert.equal(requests.length,1);assert.equal(requests[0].model,'MiniMax-M3');assert.equal(requests[0].max_tokens,12000);assert.deepEqual(requests[0].tool_choice,{type:'auto'});
  if(precheck)assert.deepEqual(requests[0].thinking,{type:'adaptive'});
  else assert.deepEqual(requests[0].thinking,{type:'disabled'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cwd,{recursive:true,force:true});}
});
