import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createClaimRecordTool} from './claim-record-tool.mjs';
const {Value}=await import(execFileSync(process.execPath,['--input-type=module','-e',"process.stdout.write(import.meta.resolve('typebox/value'))"],{cwd:process.cwd(),encoding:'utf8'}));
const data={claims:{'invariants[4]':'Converts input.',validation:[]},evidence:{'x.py':'def f(x):\n    return int(x)\n'}};
const record=(claim,extra={})=>({claim,verdict:'supported',source:0,start_line:2,end_line:2,reason:'Return int(x).',...extra});
function fixture(){const recorded=[];const original={name:'submit_specialist_review',parameters:{},async execute(id,report){recorded.push(report);return {content:[],details:{}};}};return {...createClaimRecordTool(original,data,Value),recorded};}
const announce=(f,ids)=>f.observe({type:'message_end',message:{role:'assistant',content:ids.map(id=>({type:'toolCall',name:'submit_specialist_review',id}))}});
test('multiple proofs become one complete canonical approval only at batch completion',async()=>{
 const f=fixture();announce(f,['a','b']);await f.tool.execute('a',record('C000'));assert.equal(f.recorded.length,0);
 await f.tool.execute('b',record('C001',{source:-1,start_line:0,end_line:0,reason:'Explicit empty validation collection.'}));
 assert.deepEqual(f.recorded,[{verdict:'supported',checked_claims:['invariants[4]','validation']}]);
});
test('missing records reject the batch but a bounded correction can complete the same immutable set',async()=>{
 const f=fixture();announce(f,['a']);await assert.rejects(f.tool.execute('a',record('C000')),/missing C001/);assert.equal(f.recorded.length,0);
 announce(f,['b']);await f.tool.execute('b',record('C001',{source:-1,start_line:0,end_line:0}));assert.equal(f.recorded.length,1);
});
test('unknown codes, invalid source and absent provider calls never approve',async()=>{
 for(const proposal of [record('unknown'),record('C000',{source:1}),record('C000',{start_line:3,end_line:2})]){
  const f=fixture();announce(f,['a']);await assert.rejects(f.tool.execute('a',proposal));assert.equal(f.recorded.length,0);
 }
 const f=fixture();await assert.rejects(f.tool.execute('a',record('C000')),/no matching/);
});
test('source counterexample retains its original claim identity and exact bytes',async()=>{
 const f=fixture();announce(f,['a','b']);await f.tool.execute('a',record('C000',{verdict:'unsupported'}));
 assert.equal(f.recorded[0].finding.claim,'invariants[4]');assert.equal(f.recorded[0].finding.excerpt,'    return int(x)');
 await assert.rejects(f.tool.execute('b',record('C001',{source:-1,start_line:0,end_line:0})),/terminal/);
});
test('a rejected duplicate cannot be ignored to obtain approval in the same batch',async()=>{
 const f=fixture();announce(f,['a','b','c']);await f.tool.execute('a',record('C000'));
 await assert.rejects(f.tool.execute('b',record('C000',{reason:'Different source proof.'})),/exactly/);
 await assert.rejects(f.tool.execute('c',record('C001',{source:-1,start_line:0,end_line:0})),/batch failed/);assert.equal(f.recorded.length,0);
});
