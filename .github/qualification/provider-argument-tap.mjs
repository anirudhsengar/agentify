import {createHash} from 'node:crypto';

/** Capture only tool arguments and numeric wire settings, never headers or reasoning text. */
export function installProviderArgumentTap(allowedHost='api.minimax.io') {
  const original=globalThis.fetch, requests=[], tasks=[], readers=new Set();
  async function collect(response,record) {
    const reader=response.body?.getReader();
    if(!reader)return;
    readers.add(reader);
    const decoder=new TextDecoder();let pending='';const calls=new Map();
    function packet(line) {
      if(!line.startsWith('data:'))return;
      let value;try{value=JSON.parse(line.slice(5).trim());}catch{return;}
      if(value.type==='message_start')record.response_model=value.message?.model;
      if(value.type==='content_block_start'&&value.content_block?.type==='tool_use') {
        if(calls.size>=512)return;
        const tool=value.content_block;
        calls.set(value.index,{id:tool.id,name:tool.name,raw:tool.input&&Object.keys(tool.input).length?JSON.stringify(tool.input):'',truncated:false});
      }
      if(value.type==='content_block_delta'&&value.delta?.type==='input_json_delta') {
        const call=calls.get(value.index);if(!call)return;
        const text=value.delta.partial_json;
        if(typeof text!=='string')return;
        if(call.raw.length+text.length>65536)call.truncated=true;
        call.raw=(call.raw+text).slice(0,65536);
      }
      if(value.type==='message_delta')record.stop_reason=value.delta?.stop_reason;
    }
    try {
      while(true){const {done,value}=await reader.read();if(done)break;
        pending+=decoder.decode(value,{stream:true});
        let end;while((end=pending.indexOf('\n'))>=0){packet(pending.slice(0,end));pending=pending.slice(end+1);}
        if(pending.length>1024*1024){record.tap_error='SSE line exceeded inspection bound';break;}
      }
      pending+=decoder.decode();if(pending)packet(pending);
    } catch(error){record.stream_interrupted=true;}
    finally {
      readers.delete(reader);
      record.tool_calls=[...calls.values()].map(call=>{
        let parsed;try{parsed=JSON.parse(call.raw);}catch{}
        return {id:call.id,name:call.name,truncated:call.truncated,valid_json:parsed!==undefined,
          argument_value:parsed,argument_sha256:createHash('sha256').update(call.raw).digest('hex'),
          ...(parsed===undefined?{invalid_argument_prefix:call.raw.slice(0,2048)}:{})};
      });
    }
  }
  globalThis.fetch=async function(input,init) {
    const url=new URL(typeof input==='string'?input:input.url??String(input));
    if(url.hostname!==allowedHost)return original(input,init);
    const record={request_number:requests.length+1,host:url.hostname,path:url.pathname};requests.push(record);
    try {
      const body=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():null;
      if(body){const value=JSON.parse(body);record.model=value.model;record.max_tokens=value.max_tokens;
        record.thinking=value.thinking?{type:value.thinking.type,budget_tokens:value.thinking.budget_tokens}:null;
        record.tool_choice=value.tool_choice;}
    }catch{record.request_settings_unavailable=true;}
    const response=await original(input,init);record.status=response.status;
    if(response.headers.get('content-type')?.includes('text/event-stream'))tasks.push(collect(response.clone(),record));
    return response;
  };
  return {requests,async finish(){
    globalThis.fetch=original;
    let timer;await Promise.race([Promise.allSettled(tasks),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);
    clearTimeout(timer);
    for(const reader of readers)await reader.cancel().catch(()=>{});
    await Promise.allSettled(tasks);
    return requests;
  }};
}
